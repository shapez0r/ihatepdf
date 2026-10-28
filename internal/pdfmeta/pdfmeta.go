// Package pdfmeta holds the small, pure helpers the server needs around PDF
// files: a cheap structural check of uploaded bytes and safe file names for
// storage and downloads. The PDF tools themselves (merge, split, sign, fill
// in, ...) run in the browser, so the server never parses PDF content.
package pdfmeta

import (
	"bytes"
	"errors"
	"fmt"
	"net/url"
	"path"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	// ErrNotPDF is returned when the bytes do not start like a PDF file.
	ErrNotPDF = errors.New("the file is not a PDF")
	// ErrTruncated is returned when a PDF has no end-of-file marker.
	ErrTruncated = errors.New("the PDF file is incomplete")
)

// MaxNameRunes is the longest stored file name (including ".pdf").
const MaxNameRunes = 200

// DefaultName is used when no usable file name is given.
const DefaultName = "document.pdf"

// Check verifies that b looks like a complete PDF: a "%PDF-" header within
// the first 1024 bytes (the spec allows leading junk) and an "%%EOF" marker
// within the last 2048 bytes.
func Check(b []byte) error {
	head := b
	if len(head) > 1024 {
		head = head[:1024]
	}
	if !bytes.Contains(head, []byte("%PDF-")) {
		return ErrNotPDF
	}
	tail := b
	if len(tail) > 2048 {
		tail = tail[len(tail)-2048:]
	}
	if !bytes.Contains(tail, []byte("%%EOF")) {
		return ErrTruncated
	}
	return nil
}

// CleanName turns a user-supplied file name into a safe display/storage name:
// no directories, no control characters, at most MaxNameRunes runes and always
// ending in ".pdf".
func CleanName(raw string) string {
	raw = strings.ReplaceAll(raw, "\\", "/")
	name := path.Base(strings.TrimSpace(raw))
	if name == "." || name == "/" || name == ".." {
		name = ""
	}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r == utf8.RuneError, unicode.IsControl(r):
			continue
		case strings.ContainsRune(`<>:"/\|?*`, r):
			b.WriteRune('_')
		default:
			b.WriteRune(r)
		}
	}
	base := strings.TrimSpace(b.String())
	if len(base) >= 4 && strings.EqualFold(base[len(base)-4:], ".pdf") {
		base = base[:len(base)-4]
	}
	// No leading/trailing dots or spaces (hidden files, "name .pdf").
	base = strings.Trim(base, ". ")
	if base == "" {
		return DefaultName
	}
	if r := []rune(base); len(r) > MaxNameRunes-4 {
		base = strings.TrimSpace(string(r[:MaxNameRunes-4]))
	}
	return base + ".pdf"
}

// ContentDisposition returns an attachment header value carrying the name both
// as a plain-ASCII fallback and as RFC 5987 UTF-8 (filename*).
func ContentDisposition(name string) string {
	var ascii strings.Builder
	for _, r := range name {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' || r == '%' || r == ';' {
			ascii.WriteRune('_')
			continue
		}
		ascii.WriteRune(r)
	}
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`,
		ascii.String(), strings.ReplaceAll(url.PathEscape(name), "+", "%2B"))
}
