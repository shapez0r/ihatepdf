// Package db opens the relational database (SQLite or MariaDB/MySQL) and
// applies embedded, versioned schema migrations.
package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql" // MariaDB / MySQL driver
	_ "modernc.org/sqlite"             // pure-Go SQLite driver (no CGO, static binary)
)

//go:embed migrations/sqlite/*.sql migrations/mysql/*.sql
var migrationsFS embed.FS

type Dialect string

const (
	SQLite Dialect = "sqlite"
	MySQL  Dialect = "mysql"
)

// DB wraps *sql.DB and remembers which SQL dialect is in use.
type DB struct {
	*sql.DB
	Dialect Dialect
}

const sqlitePragmas = "_pragma=busy_timeout(5000)" +
	"&_pragma=journal_mode(WAL)" +
	"&_pragma=foreign_keys(1)" +
	"&_pragma=synchronous(NORMAL)" +
	"&_pragma=temp_store(MEMORY)" +
	"&_txlock=immediate"

// Open connects to the database, waiting for it to become reachable
// (useful when the database container starts after the app).
func Open(ctx context.Context, driver, dsn string) (*DB, error) {
	var d Dialect
	switch driver {
	case "sqlite":
		d = SQLite
		if !strings.Contains(dsn, "?") {
			dsn += "?" + sqlitePragmas
		}
	case "mysql":
		d = MySQL
	default:
		return nil, fmt.Errorf("unsupported database driver %q", driver)
	}

	sqlDB, err := sql.Open(string(d), dsn)
	if err != nil {
		return nil, err
	}
	if d == SQLite {
		// WAL allows concurrent readers; writers are serialised by SQLite itself.
		sqlDB.SetMaxOpenConns(8)
		sqlDB.SetMaxIdleConns(8)
	} else {
		sqlDB.SetMaxOpenConns(25)
		sqlDB.SetMaxIdleConns(25)
		sqlDB.SetConnMaxLifetime(5 * time.Minute)
	}

	var pingErr error
	for attempt := 0; attempt < 30; attempt++ {
		pctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		pingErr = sqlDB.PingContext(pctx)
		cancel()
		if pingErr == nil {
			return &DB{DB: sqlDB, Dialect: d}, nil
		}
		select {
		case <-ctx.Done():
			sqlDB.Close()
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	sqlDB.Close()
	return nil, fmt.Errorf("database not reachable: %w", pingErr)
}

// Migrate applies all pending migrations for the active dialect. It is safe
// to call from several replicas at once: MariaDB uses a named lock, SQLite
// serialises through its immediate write transactions.
func (db *DB) Migrate(ctx context.Context) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	if db.Dialect == MySQL {
		var got sql.NullInt64
		if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK('ihatepdf_migrate', 120)").Scan(&got); err != nil {
			return fmt.Errorf("acquire migration lock: %w", err)
		}
		if !got.Valid || got.Int64 != 1 {
			return fmt.Errorf("could not acquire migration lock")
		}
		defer conn.ExecContext(context.Background(), "SELECT RELEASE_LOCK('ihatepdf_migrate')")
	}

	if _, err := conn.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version VARCHAR(64) NOT NULL PRIMARY KEY,
		applied_at BIGINT NOT NULL
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	dir := "migrations/" + string(db.Dialect)
	entries, err := fs.ReadDir(migrationsFS, dir)
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		version := strings.TrimSuffix(name, ".sql")
		var n int
		if err := conn.QueryRowContext(ctx, "SELECT COUNT(*) FROM schema_migrations WHERE version = ?", version).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		body, err := migrationsFS.ReadFile(dir + "/" + name)
		if err != nil {
			return err
		}
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		for _, stmt := range splitStatements(string(body)) {
			if _, err := tx.ExecContext(ctx, stmt); err != nil {
				tx.Rollback()
				return fmt.Errorf("migration %s: %w", name, err)
			}
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", version, time.Now().Unix()); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// splitStatements strips "--" comment lines and splits on semicolons.
// Migrations must not contain semicolons inside string literals.
func splitStatements(src string) []string {
	var b strings.Builder
	for _, line := range strings.Split(src, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	var out []string
	for _, s := range strings.Split(b.String(), ";") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}
