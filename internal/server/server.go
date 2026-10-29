// Package server wires the HTTP API (Fiber) and the embedded web UI.
// The server is stateless: sessions and files live in the database (with a
// cache in front of session lookups), so any number of replicas can run
// behind a load balancer.
//
// The PDF tools themselves (merge, split, organize, sign, fill in, ...) run in
// the browser with the bundled pdf-lib and pdf.js libraries: documents never
// have to leave the device unless the user saves them to "My files".
package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/compress"
	"github.com/gofiber/fiber/v2/middleware/filesystem"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/gofiber/fiber/v2/middleware/recover"

	"ihatepdf/internal/cache"
	"ihatepdf/internal/config"
	"ihatepdf/internal/db"
	"ihatepdf/internal/store"
	"ihatepdf/web"
)

const sessionCookie = "ihatepdf_session"

type Server struct {
	cfg     *config.Config
	db      *db.DB
	store   *store.Store
	cache   cache.Cache
	log     *slog.Logger
	app     *fiber.App
	version string
}

func New(cfg *config.Config, database *db.DB, c cache.Cache, log *slog.Logger, version string) *Server {
	s := &Server{
		cfg:     cfg,
		db:      database,
		store:   store.New(database),
		cache:   c,
		log:     log,
		version: version,
	}

	app := fiber.New(fiber.Config{
		AppName:               "ihatepdf",
		DisableStartupMessage: true,
		ReadTimeout:           2 * time.Minute, // large PDF uploads from phones and tablets
		WriteTimeout:          2 * time.Minute,
		IdleTimeout:           120 * time.Second,
		BodyLimit:             int(cfg.MaxFileBytes) + 64*1024,
		ProxyHeader:           cfg.ProxyHeader,
		EnableIPValidation:    true,
		ErrorHandler:          s.errorHandler,
	})
	s.app = app

	app.Use(recover.New())
	if cfg.LogRequests {
		app.Use(logger.New(logger.Config{
			Format: "${time} ${ip} ${status} ${method} ${path} ${latency}\n",
		}))
	}
	// PDFs are already compressed internally; do not spend CPU on them.
	app.Use(compress.New(compress.Config{
		Next: func(c *fiber.Ctx) bool { return strings.HasSuffix(c.Path(), "/file") },
	}))
	app.Use(securityHeaders)
	if cfg.BasePath != "" {
		app.Use(stripBasePath(cfg.BasePath))
	}

	app.Get("/healthz", s.healthz)
	app.Get("/readyz", s.readyz)

	api := app.Group("/api", noStore)
	api.Get("/config", s.getConfig)

	authLimiter := limiter.New(limiter.Config{
		Max:        20,
		Expiration: time.Minute,
		LimitReached: func(c *fiber.Ctx) error {
			return fiber.NewError(fiber.StatusTooManyRequests, "too many attempts, try again in a minute")
		},
	})
	api.Post("/auth/signup", authLimiter, requireJSON, s.signup)
	api.Post("/auth/login", authLimiter, requireJSON, s.login)
	api.Post("/auth/logout", s.logout)

	priv := api.Group("", s.requireAuth)
	priv.Get("/me", s.me)
	priv.Get("/documents", s.listDocuments)
	priv.Post("/documents", requirePDF, s.createDocument)
	priv.Get("/documents/:id", s.getDocument)
	priv.Patch("/documents/:id", requireJSON, s.renameDocument)
	priv.Delete("/documents/:id", requireJSON, s.deleteDocument)
	priv.Get("/documents/:id/file", s.downloadDocument)
	priv.Put("/documents/:id/file", requirePDF, s.replaceDocument)

	api.Use(func(c *fiber.Ctx) error {
		return fiber.NewError(fiber.StatusNotFound, "unknown API endpoint")
	})

	// Embedded single-page web UI (no separate frontend deployment needed).
	// The UI must never run a stale app.js from the browser cache after an
	// update: index.html links app.js/app.css with a content hash and all UI
	// files are revalidated on every load.
	ui := web.Static()
	index := versionedIndex(ui)
	// "no-transform" stops proxies/CDNs (e.g. a Cloudflare Tunnel with Rocket
	// Loader, Email Obfuscation or auto-minify enabled) from rewriting the page.
	// Rocket Loader changes every <script> into a deferred inline loader, which
	// our CSP (script-src 'self') blocks, so no JS runs and both views stay
	// hidden: a blank page through the tunnel, while direct LAN access works.
	serveIndex := func(c *fiber.Ctx) error {
		c.Set("Cache-Control", "no-cache, no-transform")
		c.Type("html", "utf-8")
		return c.Send(index)
	}
	app.Get("/", serveIndex)
	app.Get("/index.html", serveIndex)
	app.Use("/", func(c *fiber.Ctx) error {
		c.Set("Cache-Control", "no-cache, no-transform")
		return c.Next()
	}, filesystem.New(filesystem.Config{
		Root:         http.FS(ui),
		Index:        "index.html",
		NotFoundFile: "index.html",
	}))

	return s
}

func (s *Server) Listen() error {
	s.log.Info("ihatepdf listening", "addr", s.cfg.Addr, "db", string(s.db.Dialect), "cache", s.cache.Name(), "version", s.version)
	return s.app.Listen(s.cfg.Addr)
}

func (s *Server) Shutdown(timeout time.Duration) error {
	return s.app.ShutdownWithTimeout(timeout)
}

// RunJanitor periodically purges expired sessions until ctx is cancelled.
func (s *Server) RunJanitor(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if n, err := s.store.DeleteExpiredSessions(ctx); err != nil && ctx.Err() == nil {
			s.log.Warn("session cleanup failed", "err", err)
		} else if n > 0 {
			s.log.Info("expired sessions removed", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// versionedIndex returns index.html with "?v=<content hash>" appended to the
// app.js and app.css links, so browsers load the new UI right after an update.
func versionedIndex(ui fs.FS) []byte {
	page, err := fs.ReadFile(ui, "index.html")
	if err != nil {
		return nil
	}
	h := sha256.New()
	for _, name := range []string{"app.js", "app.css", "i18n.js", "theme.js"} {
		if b, err := fs.ReadFile(ui, name); err == nil {
			h.Write(b)
		}
	}
	v := hex.EncodeToString(h.Sum(nil))[:12]
	out := string(page)
	for _, name := range []string{"app.js", "i18n.js", "theme.js"} {
		out = strings.Replace(out, `src="`+name+`"`, `src="`+name+`?v=`+v+`"`, 1)
	}
	out = strings.Replace(out, `href="app.css"`, `href="app.css?v=`+v+`"`, 1)
	return []byte(out)
}

// ---------- middleware & helpers ----------

// securityHeaders: everything (scripts, the pdf.js worker, fonts, wasm
// decoders) is served from this server; nothing is loaded from elsewhere.
// 'wasm-unsafe-eval' only allows WebAssembly (pdf.js image decoders), not eval.
func securityHeaders(c *fiber.Ctx) error {
	c.Set("X-Content-Type-Options", "nosniff")
	c.Set("X-Frame-Options", "DENY")
	c.Set("Referrer-Policy", "same-origin")
	c.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; "+
		"script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
	return c.Next()
}

// stripBasePath serves the app under a URL prefix (IHATEPDF_BASE_PATH, e.g.
// "/ihatepdf"): "/ihatepdf/api/me" is routed as "/api/me". "/ihatepdf" is
// redirected to "/ihatepdf/" so the UI's relative URLs resolve correctly.
// /healthz and /readyz also stay reachable without the prefix (healthchecks).
func stripBasePath(base string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		p := c.Path()
		switch {
		case p == base:
			target := base + "/"
			if q := string(c.Request().URI().QueryString()); q != "" {
				target += "?" + q
			}
			return c.Redirect(target, fiber.StatusMovedPermanently)
		case strings.HasPrefix(p, base+"/"):
			c.Path(p[len(base):])
			return c.Next()
		case p == "/healthz" || p == "/readyz":
			return c.Next()
		}
		return fiber.NewError(fiber.StatusNotFound, "not found")
	}
}

func noStore(c *fiber.Ctx) error {
	c.Set("Cache-Control", "no-store")
	return c.Next()
}

// requireJSON rejects state-changing requests that are not JSON. Together with
// the SameSite session cookie this blocks cross-site form (CSRF) submissions.
func requireJSON(c *fiber.Ctx) error {
	switch c.Method() {
	case fiber.MethodPost, fiber.MethodPut, fiber.MethodPatch:
		if !strings.HasPrefix(strings.ToLower(c.Get(fiber.HeaderContentType)), fiber.MIMEApplicationJSON) {
			return fiber.NewError(fiber.StatusUnsupportedMediaType, "content type must be application/json")
		}
	case fiber.MethodDelete:
		if c.Get("X-Requested-With") == "" && !strings.HasPrefix(strings.ToLower(c.Get(fiber.HeaderContentType)), fiber.MIMEApplicationJSON) {
			return fiber.NewError(fiber.StatusBadRequest, "missing X-Requested-With header")
		}
	}
	return c.Next()
}

// requirePDF accepts raw PDF uploads. A custom header is required: browsers
// never send one on cross-site requests without a CORS preflight, which this
// server does not allow (CSRF protection, like requireJSON).
func requirePDF(c *fiber.Ctx) error {
	if !strings.HasPrefix(strings.ToLower(c.Get(fiber.HeaderContentType)), "application/pdf") {
		return fiber.NewError(fiber.StatusUnsupportedMediaType, "content type must be application/pdf")
	}
	if c.Get("X-Requested-With") == "" {
		return fiber.NewError(fiber.StatusBadRequest, "missing X-Requested-With header")
	}
	return c.Next()
}

func (s *Server) errorHandler(c *fiber.Ctx, err error) error {
	code := fiber.StatusInternalServerError
	msg := "internal server error"
	var fe *fiber.Error
	switch {
	case errors.As(err, &fe):
		code, msg = fe.Code, fe.Message
	case errors.Is(err, store.ErrNotFound):
		code, msg = fiber.StatusNotFound, "not found"
	case errors.Is(err, store.ErrConflict):
		code, msg = fiber.StatusConflict, "already exists"
	default:
		s.log.Error("request failed", "method", c.Method(), "path", c.Path(), "err", err)
	}
	return c.Status(code).JSON(fiber.Map{"error": msg})
}

func badRequest(msg string) error { return fiber.NewError(fiber.StatusBadRequest, msg) }

func (s *Server) healthz(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{"status": "ok", "version": s.version})
}

func (s *Server) readyz(c *fiber.Ctx) error {
	ctx, cancel := context.WithTimeout(c.UserContext(), 2*time.Second)
	defer cancel()
	if err := s.db.PingContext(ctx); err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"status": "db unavailable"})
	}
	if err := s.cache.Ping(ctx); err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"status": "cache unavailable"})
	}
	return c.JSON(fiber.Map{"status": "ready"})
}

func (s *Server) getConfig(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"signup_enabled": s.cfg.SignupAllowedFrom(c.IP()),
		"version":        s.version,
		"max_file_bytes": s.cfg.MaxFileBytes,
		"quota_bytes":    s.cfg.QuotaBytes,
	})
}
