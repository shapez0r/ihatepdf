// Package config loads ihatepdf runtime configuration from environment
// variables. Every setting has a sane default so the binary runs with zero
// configuration on a laptop or home-lab machine.
package config

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// DefaultAddr is the listen address when IHATEPDF_ADDR is not set. It is
// :8081 so ihatepdf can run next to eurofish (:8080) on the same machine.
const DefaultAddr = ":8081"

type Config struct {
	// Addr is the listen address, e.g. ":8081" (all interfaces, reachable from the LAN).
	Addr string
	// DataDir holds the SQLite database when the sqlite driver is used.
	DataDir string
	// DBDriver is "sqlite" (default, single node) or "mysql"/"mariadb" (shared, multi-node).
	DBDriver string
	// DBDSN is the driver-specific data source name.
	DBDSN string
	// CacheURL is "memory" (in-process) or a redis:// / rediss:// URL pointing at Valkey or Redis.
	CacheURL string
	// SessionTTL is how long a login session stays valid.
	SessionTTL time.Duration
	// CookieSecure marks the session cookie Secure. Enable when serving over HTTPS.
	CookieSecure bool
	// AllowSignup enables self-service account creation.
	AllowSignup bool
	// SignupCIDRs optionally restricts sign-up to clients from these networks
	// (e.g. your home LAN). Empty means any address may sign up.
	SignupCIDRs []*net.IPNet
	// ProxyHeader is the header carrying the real client IP when running
	// behind a trusted reverse proxy (e.g. "X-Forwarded-For"). Empty = use the socket address.
	ProxyHeader string
	// LogRequests enables per-request access logging.
	LogRequests bool
	// MaxFileBytes is the largest PDF that can be saved to "My files".
	MaxFileBytes int64
	// QuotaBytes is the total size of "My files" per user (0 = unlimited).
	QuotaBytes int64
}

func Load() (*Config, error) {
	c := &Config{
		Addr:        env("IHATEPDF_ADDR", DefaultAddr),
		DataDir:     env("IHATEPDF_DATA_DIR", "./data"),
		DBDriver:    strings.ToLower(env("IHATEPDF_DB_DRIVER", "sqlite")),
		CacheURL:    env("IHATEPDF_CACHE_URL", "memory"),
		ProxyHeader: env("IHATEPDF_PROXY_HEADER", ""),
	}
	var err error
	if c.SessionTTL, err = time.ParseDuration(env("IHATEPDF_SESSION_TTL", "720h")); err != nil {
		return nil, fmt.Errorf("IHATEPDF_SESSION_TTL: %w", err)
	}
	if c.CookieSecure, err = envBool("IHATEPDF_COOKIE_SECURE", false); err != nil {
		return nil, err
	}
	if c.AllowSignup, err = envBool("IHATEPDF_ALLOW_SIGNUP", true); err != nil {
		return nil, err
	}
	if c.LogRequests, err = envBool("IHATEPDF_LOG_REQUESTS", true); err != nil {
		return nil, err
	}
	maxMB, err := envInt("IHATEPDF_MAX_FILE_MB", 50)
	if err != nil {
		return nil, err
	}
	if maxMB < 1 || maxMB > 1024 {
		return nil, fmt.Errorf("IHATEPDF_MAX_FILE_MB must be between 1 and 1024")
	}
	c.MaxFileBytes = int64(maxMB) << 20
	quotaMB, err := envInt("IHATEPDF_QUOTA_MB", 2048)
	if err != nil {
		return nil, err
	}
	if quotaMB < 0 {
		return nil, fmt.Errorf("IHATEPDF_QUOTA_MB must not be negative")
	}
	c.QuotaBytes = int64(quotaMB) << 20
	for _, raw := range strings.Split(env("IHATEPDF_SIGNUP_CIDRS", ""), ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		_, n, err := net.ParseCIDR(raw)
		if err != nil {
			return nil, fmt.Errorf("IHATEPDF_SIGNUP_CIDRS: %w", err)
		}
		c.SignupCIDRs = append(c.SignupCIDRs, n)
	}

	c.DBDSN = env("IHATEPDF_DB_DSN", "")
	switch c.DBDriver {
	case "sqlite", "sqlite3":
		c.DBDriver = "sqlite"
		if c.DBDSN == "" {
			c.DBDSN = "file:" + filepath.Join(c.DataDir, "ihatepdf.db")
		}
	case "mysql", "mariadb":
		c.DBDriver = "mysql"
		if c.DBDSN == "" {
			return nil, fmt.Errorf("IHATEPDF_DB_DSN is required for the %s driver", c.DBDriver)
		}
	default:
		return nil, fmt.Errorf("IHATEPDF_DB_DRIVER: unsupported driver %q (use sqlite or mariadb)", c.DBDriver)
	}
	if c.SessionTTL < time.Hour {
		return nil, fmt.Errorf("IHATEPDF_SESSION_TTL must be at least 1h")
	}
	return c, nil
}

// SignupAllowedFrom reports whether a client IP may create an account.
func (c *Config) SignupAllowedFrom(ip string) bool {
	if !c.AllowSignup {
		return false
	}
	if len(c.SignupCIDRs) == 0 {
		return true
	}
	parsed := net.ParseIP(strings.TrimSpace(ip))
	if parsed == nil {
		return false
	}
	for _, n := range c.SignupCIDRs {
		if n.Contains(parsed) {
			return true
		}
	}
	return false
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return def
}

func envBool(key string, def bool) (bool, error) {
	v := env(key, "")
	if v == "" {
		return def, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("%s: %w", key, err)
	}
	return b, nil
}

func envInt(key string, def int) (int, error) {
	v := env(key, "")
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return n, nil
}
