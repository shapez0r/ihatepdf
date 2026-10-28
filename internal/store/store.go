// Package store is the data-access layer. All SQL lives here and is written
// to run unchanged on both SQLite and MariaDB/MySQL.
package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"ihatepdf/internal/db"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("already exists")
)

type User struct {
	ID           string `json:"id"`
	Email        string `json:"email"`
	DisplayName  string `json:"display_name"`
	PasswordHash string `json:"-"`
	CreatedAt    int64  `json:"created_at"`
}

// Document is a PDF in a user's "My files" (metadata only; the bytes are
// read separately so that listing never loads file contents).
type Document struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Pages     int    `json:"pages"`
	SHA256    string `json:"sha256"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

type Store struct {
	db *db.DB
}

func New(d *db.DB) *Store { return &Store{db: d} }

func isDuplicate(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "UNIQUE constraint failed") || // SQLite
		strings.Contains(msg, "Duplicate entry") || // MariaDB / MySQL (1062)
		strings.Contains(msg, "constraint failed: PRIMARY KEY")
}

func nullable(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}

// ---------- users ----------

func (s *Store) CreateUser(ctx context.Context, u *User) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
		u.ID, u.Email, u.DisplayName, nullable(u.PasswordHash), u.CreatedAt)
	if isDuplicate(err) {
		return ErrConflict
	}
	return err
}

func (s *Store) scanUser(row *sql.Row) (*User, error) {
	var u User
	var pw sql.NullString
	err := row.Scan(&u.ID, &u.Email, &u.DisplayName, &pw, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.PasswordHash = pw.String
	return &u, nil
}

func (s *Store) UserByEmail(ctx context.Context, email string) (*User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx,
		`SELECT id, email, display_name, password_hash, created_at FROM users WHERE email = ?`, email))
}

func (s *Store) UserByID(ctx context.Context, id string) (*User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx,
		`SELECT id, email, display_name, password_hash, created_at FROM users WHERE id = ?`, id))
}

// ---------- sessions ----------

func (s *Store) CreateSession(ctx context.Context, tokenHash, userID string, expires time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
		tokenHash, userID, expires.Unix(), time.Now().Unix())
	return err
}

// SessionUser returns the user that owns a valid (non-expired) session and the expiry time.
func (s *Store) SessionUser(ctx context.Context, tokenHash string) (*User, time.Time, error) {
	var u User
	var pw sql.NullString
	var exp int64
	err := s.db.QueryRowContext(ctx,
		`SELECT u.id, u.email, u.display_name, u.password_hash, u.created_at, s.expires_at
		   FROM sessions s JOIN users u ON u.id = s.user_id
		  WHERE s.token_hash = ? AND s.expires_at > ?`, tokenHash, time.Now().Unix()).
		Scan(&u.ID, &u.Email, &u.DisplayName, &pw, &u.CreatedAt, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, time.Time{}, ErrNotFound
	}
	if err != nil {
		return nil, time.Time{}, err
	}
	u.PasswordHash = pw.String
	return &u, time.Unix(exp, 0), nil
}

func (s *Store) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

func (s *Store) DeleteExpiredSessions(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ---------- documents ("My files") ----------

const documentCols = `id, name, size, pages, sha256, created_at, updated_at`

func scanDocument(sc interface{ Scan(...any) error }) (*Document, error) {
	var d Document
	if err := sc.Scan(&d.ID, &d.Name, &d.Size, &d.Pages, &d.SHA256, &d.CreatedAt, &d.UpdatedAt); err != nil {
		return nil, err
	}
	return &d, nil
}

// ListDocuments returns the user's files, most recently changed first.
func (s *Store) ListDocuments(ctx context.Context, ownerID string) ([]Document, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+documentCols+` FROM documents WHERE owner_id = ? ORDER BY updated_at DESC, id`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Document{}
	for rows.Next() {
		d, err := scanDocument(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// Document returns the metadata of one of the user's files.
func (s *Store) Document(ctx context.Context, ownerID, id string) (*Document, error) {
	d, err := scanDocument(s.db.QueryRowContext(ctx,
		`SELECT `+documentCols+` FROM documents WHERE id = ? AND owner_id = ?`, id, ownerID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return d, err
}

// DocumentContent returns the metadata and the PDF bytes of one of the user's files.
func (s *Store) DocumentContent(ctx context.Context, ownerID, id string) (*Document, []byte, error) {
	var d Document
	var content []byte
	err := s.db.QueryRowContext(ctx,
		`SELECT `+documentCols+`, content FROM documents WHERE id = ? AND owner_id = ?`, id, ownerID).
		Scan(&d.ID, &d.Name, &d.Size, &d.Pages, &d.SHA256, &d.CreatedAt, &d.UpdatedAt, &content)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	return &d, content, nil
}

// UsedBytes is the total size of the user's files, not counting exceptID
// (the file being replaced, if any).
func (s *Store) UsedBytes(ctx context.Context, ownerID, exceptID string) (int64, error) {
	var used sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		`SELECT SUM(size) FROM documents WHERE owner_id = ? AND id <> ?`, ownerID, exceptID).Scan(&used)
	return used.Int64, err
}

func (s *Store) CreateDocument(ctx context.Context, ownerID string, d *Document, content []byte) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO documents (id, owner_id, name, size, pages, sha256, content, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		d.ID, ownerID, d.Name, d.Size, d.Pages, d.SHA256, content, d.CreatedAt, d.UpdatedAt)
	if isDuplicate(err) {
		return ErrConflict
	}
	return err
}

// ReplaceDocument stores new bytes for an existing file (e.g. after filling
// it in or signing it). d carries the new size, pages, hash and update time.
func (s *Store) ReplaceDocument(ctx context.Context, ownerID string, d *Document, content []byte) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE documents SET size = ?, pages = ?, sha256 = ?, content = ?, updated_at = ?
		  WHERE id = ? AND owner_id = ?`,
		d.Size, d.Pages, d.SHA256, content, d.UpdatedAt, d.ID, ownerID)
	if err != nil {
		return err
	}
	return s.mustExist(ctx, res, ownerID, d.ID)
}

func (s *Store) RenameDocument(ctx context.Context, ownerID, id, name string, updatedAt int64) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE documents SET name = ?, updated_at = ? WHERE id = ? AND owner_id = ?`,
		name, updatedAt, id, ownerID)
	if err != nil {
		return err
	}
	return s.mustExist(ctx, res, ownerID, id)
}

func (s *Store) DeleteDocument(ctx context.Context, ownerID, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM documents WHERE id = ? AND owner_id = ?`, id, ownerID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// mustExist turns "0 rows affected" into ErrNotFound. MariaDB reports 0
// affected rows when nothing changed, so existence is double-checked.
func (s *Store) mustExist(ctx context.Context, res sql.Result, ownerID, id string) error {
	if n, _ := res.RowsAffected(); n > 0 {
		return nil
	}
	var c int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM documents WHERE id = ? AND owner_id = ?`, id, ownerID).Scan(&c); err != nil {
		return err
	}
	if c == 0 {
		return ErrNotFound
	}
	return nil
}
