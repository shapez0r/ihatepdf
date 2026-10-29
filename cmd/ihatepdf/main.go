// Command ihatepdf is the self-contained ihatepdf server: HTTP API, web UI,
// migrations and background jobs in one static binary.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"ihatepdf/internal/cache"
	"ihatepdf/internal/config"
	"ihatepdf/internal/db"
	"ihatepdf/internal/server"
	"ihatepdf/internal/store"
)

// version is set at build time: -ldflags "-X main.version=1.2.3"
var version = "dev"

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "serve":
		if err := serve(); err != nil {
			fmt.Fprintln(os.Stderr, "ihatepdf:", err)
			os.Exit(1)
		}
	case "migrate":
		if err := migrateOnly(); err != nil {
			fmt.Fprintln(os.Stderr, "ihatepdf:", err)
			os.Exit(1)
		}
	case "reset":
		if err := reset(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "ihatepdf:", err)
			os.Exit(1)
		}
	case "healthcheck":
		os.Exit(healthcheck())
	case "version", "--version", "-v":
		fmt.Println(version)
	default:
		fmt.Fprintf(os.Stderr, "usage: ihatepdf [serve|migrate|reset --yes|healthcheck|version]\n")
		os.Exit(2)
	}
}

func serve() error {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	database, err := openDB(ctx, cfg)
	if err != nil {
		return err
	}
	defer database.Close()

	c, err := cache.New(cfg.CacheURL)
	if err != nil {
		return err
	}
	defer c.Close()

	srv := server.New(cfg, database, c, log, version)
	go srv.RunJanitor(ctx)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Listen() }()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	return srv.Shutdown(15 * time.Second)
}

func migrateOnly() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	database, err := openDB(context.Background(), cfg)
	if err != nil {
		return err
	}
	return database.Close()
}

// reset erases all users, sessions and My files. It requires --yes so that it
// cannot be run by accident. Stop the server first.
func reset(args []string) error {
	confirmed := false
	for _, a := range args {
		if a == "--yes" || a == "-y" {
			confirmed = true
		}
	}
	if !confirmed {
		return fmt.Errorf("this deletes ALL users and ALL files; run \"ihatepdf reset --yes\" to confirm")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx := context.Background()
	database, err := openDB(ctx, cfg)
	if err != nil {
		return err
	}
	defer database.Close()
	if err := store.New(database).ResetAll(ctx); err != nil {
		return fmt.Errorf("reset: %w", err)
	}
	if database.Dialect == db.SQLite {
		// Give the freed space back to the file system.
		if _, err := database.ExecContext(ctx, "VACUUM"); err != nil {
			return fmt.Errorf("vacuum: %w", err)
		}
	}
	fmt.Println("all users and files were deleted")
	return nil
}

func openDB(ctx context.Context, cfg *config.Config) (*db.DB, error) {
	if cfg.DBDriver == "sqlite" {
		if err := os.MkdirAll(cfg.DataDir, 0o750); err != nil {
			return nil, fmt.Errorf("create data dir: %w", err)
		}
	}
	database, err := db.Open(ctx, cfg.DBDriver, cfg.DBDSN)
	if err != nil {
		return nil, err
	}
	if err := database.Migrate(ctx); err != nil {
		database.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return database, nil
}

// healthcheck is used by container HEALTHCHECKs (the scratch image has no curl).
func healthcheck() int {
	addr := strings.TrimSpace(os.Getenv("IHATEPDF_ADDR"))
	if addr == "" {
		addr = config.DefaultAddr
	}
	port := addr[strings.LastIndex(addr, ":")+1:]
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
