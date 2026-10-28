// Package auth contains password hashing, session token helpers and the
// extension point for external identity providers (Google, Apple, ...).
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"

	"golang.org/x/crypto/bcrypt"
)

const bcryptCost = 12

var ErrInvalidPassword = errors.New("password must be between 8 and 72 bytes")

func HashPassword(pw string) (string, error) {
	if len(pw) < 8 || len(pw) > 72 {
		return "", ErrInvalidPassword
	}
	h, err := bcrypt.GenerateFromPassword([]byte(pw), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

func CheckPassword(hash, pw string) bool {
	if hash == "" || len(pw) > 72 {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

// dummyHash is compared against when a user does not exist so that login
// timing does not reveal which e-mail addresses are registered.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("ihatepdf-timing-equaliser"), bcryptCost)

func BurnPasswordCheck(pw string) {
	_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(pw))
}

// NewSessionToken returns a random opaque token for the client cookie and the
// SHA-256 hash that is stored server-side (a DB leak does not leak sessions).
func NewSessionToken() (token, hash string, err error) {
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	return token, HashToken(token), nil
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NewID returns a random RFC 4122 version 4 UUID.
func NewID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Identity is what an external provider returns after a successful login.
type Identity struct {
	Provider    string // "google", "apple", ...
	Subject     string // stable provider-specific user id
	Email       string
	DisplayName string
}

// Provider is the extension point for upcoming Google / Apple sign-in.
// Implementations are registered in the server and linked to users through
// the auth_identities table; local e-mail/password accounts keep working.
type Provider interface {
	Name() string
	AuthCodeURL(state string) string
	Exchange(ctx context.Context, code string) (Identity, error)
}
