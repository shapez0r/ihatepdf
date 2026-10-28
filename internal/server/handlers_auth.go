package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v2"

	"ihatepdf/internal/auth"
	"ihatepdf/internal/store"
)

const sessionCacheTTL = time.Minute

type credentials struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
}

func normalizeEmail(raw string) (string, error) {
	e := strings.ToLower(strings.TrimSpace(raw))
	if len(e) < 3 || len(e) > 254 {
		return "", badRequest("invalid e-mail address")
	}
	addr, err := mail.ParseAddress(e)
	if err != nil || addr.Address != e || !strings.Contains(e, "@") {
		return "", badRequest("invalid e-mail address")
	}
	return e, nil
}

func (s *Server) signup(c *fiber.Ctx) error {
	if !s.cfg.SignupAllowedFrom(c.IP()) {
		return fiber.NewError(fiber.StatusForbidden, "sign-up is disabled for your network")
	}
	var in credentials
	if err := c.BodyParser(&in); err != nil {
		return badRequest("invalid JSON body")
	}
	email, err := normalizeEmail(in.Email)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(in.DisplayName)
	if name == "" {
		name = strings.SplitN(email, "@", 2)[0]
	}
	if utf8.RuneCountInString(name) > 100 {
		return badRequest("display name is too long")
	}
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidPassword) {
			return badRequest(err.Error())
		}
		return err
	}
	u := &store.User{
		ID:           auth.NewID(),
		Email:        email,
		DisplayName:  name,
		PasswordHash: hash,
		CreatedAt:    time.Now().Unix(),
	}
	if err := s.store.CreateUser(c.UserContext(), u); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return fiber.NewError(fiber.StatusConflict, "an account with this e-mail already exists")
		}
		return err
	}
	if err := s.startSession(c, u.ID); err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(u)
}

func (s *Server) login(c *fiber.Ctx) error {
	var in credentials
	if err := c.BodyParser(&in); err != nil {
		return badRequest("invalid JSON body")
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	u, err := s.store.UserByEmail(c.UserContext(), email)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if u == nil {
		auth.BurnPasswordCheck(in.Password)
		return fiber.NewError(fiber.StatusUnauthorized, "wrong e-mail or password")
	}
	if !auth.CheckPassword(u.PasswordHash, in.Password) {
		return fiber.NewError(fiber.StatusUnauthorized, "wrong e-mail or password")
	}
	if err := s.startSession(c, u.ID); err != nil {
		return err
	}
	return c.JSON(u)
}

func (s *Server) logout(c *fiber.Ctx) error {
	if token := c.Cookies(sessionCookie); token != "" {
		hash := auth.HashToken(token)
		if err := s.store.DeleteSession(c.UserContext(), hash); err != nil {
			return err
		}
		_ = s.cache.Delete(c.UserContext(), "sess:"+hash)
	}
	s.setCookie(c, "", time.Unix(0, 0))
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) me(c *fiber.Ctx) error {
	return c.JSON(currentUser(c))
}

func (s *Server) startSession(c *fiber.Ctx, userID string) error {
	token, hash, err := auth.NewSessionToken()
	if err != nil {
		return err
	}
	expires := time.Now().Add(s.cfg.SessionTTL)
	if err := s.store.CreateSession(c.UserContext(), hash, userID, expires); err != nil {
		return err
	}
	s.setCookie(c, token, expires)
	return nil
}

func (s *Server) setCookie(c *fiber.Ctx, value string, expires time.Time) {
	c.Cookie(&fiber.Cookie{
		Name:     sessionCookie,
		Value:    value,
		Path:     "/",
		Expires:  expires,
		HTTPOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: fiber.CookieSameSiteLaxMode,
	})
}

type cachedSession struct {
	User    store.User `json:"user"`
	Expires int64      `json:"expires"`
}

// requireAuth resolves the session cookie to a user. Lookups are cached
// (in-process or Valkey) for a short time to keep the database out of the hot path.
func (s *Server) requireAuth(c *fiber.Ctx) error {
	token := c.Cookies(sessionCookie)
	if token == "" {
		return fiber.NewError(fiber.StatusUnauthorized, "not signed in")
	}
	hash := auth.HashToken(token)
	key := "sess:" + hash
	ctx := c.UserContext()

	if raw, ok, err := s.cache.Get(ctx, key); err == nil && ok {
		var cs cachedSession
		if json.Unmarshal(raw, &cs) == nil && time.Now().Unix() < cs.Expires {
			u := cs.User
			c.Locals("user", &u)
			return c.Next()
		}
	}

	u, expires, err := s.store.SessionUser(ctx, hash)
	if errors.Is(err, store.ErrNotFound) {
		return fiber.NewError(fiber.StatusUnauthorized, "session expired, please sign in again")
	}
	if err != nil {
		return err
	}
	s.cacheSession(ctx, key, u, expires)
	c.Locals("user", u)
	return c.Next()
}

func (s *Server) cacheSession(ctx context.Context, key string, u *store.User, expires time.Time) {
	ttl := sessionCacheTTL
	if until := time.Until(expires); until < ttl {
		ttl = until
	}
	if ttl <= 0 {
		return
	}
	safe := *u
	safe.PasswordHash = ""
	if raw, err := json.Marshal(cachedSession{User: safe, Expires: expires.Unix()}); err == nil {
		_ = s.cache.Set(ctx, key, raw, ttl)
	}
}

func currentUser(c *fiber.Ctx) *store.User {
	u, _ := c.Locals("user").(*store.User)
	return u
}
