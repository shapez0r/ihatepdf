package pdfmeta

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestCheck(t *testing.T) {
	ok := []byte("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n")
	if err := Check(ok); err != nil {
		t.Fatalf("valid pdf: %v", err)
	}
	// Leading junk before the header is allowed.
	if err := Check(append([]byte("junk\n"), ok...)); err != nil {
		t.Fatalf("leading junk: %v", err)
	}
	if err := Check([]byte("hello world %%EOF")); !errors.Is(err, ErrNotPDF) {
		t.Fatalf("not a pdf: got %v", err)
	}
	if err := Check([]byte("%PDF-1.4\n1 0 obj")); !errors.Is(err, ErrTruncated) {
		t.Fatalf("truncated: got %v", err)
	}
	// Header far away from the start is rejected.
	far := append(bytes.Repeat([]byte(" "), 2000), ok...)
	if err := Check(far); !errors.Is(err, ErrNotPDF) {
		t.Fatalf("late header: got %v", err)
	}
	if err := Check(nil); !errors.Is(err, ErrNotPDF) {
		t.Fatalf("empty: got %v", err)
	}
}

func TestCleanName(t *testing.T) {
	cases := map[string]string{
		"report.pdf":              "report.pdf",
		"report":                  "report.pdf",
		"Report.PDF":              "Report.pdf",
		"  spaced name .pdf ":     "spaced name.pdf",
		"../../etc/passwd":        "passwd.pdf",
		`C:\Users\me\scan.pdf`:    "scan.pdf",
		"":                        DefaultName,
		".pdf":                    DefaultName,
		"..":                      DefaultName,
		"a<b>c:d\"e|f?g*h.pdf":    "a_b_c_d_e_f_g_h.pdf",
		"ctrl\x00\x07char.pdf":    "ctrlchar.pdf",
		"Договор аренды.pdf":      "Договор аренды.pdf",
		"contrato (firmado).pdf": "contrato (firmado).pdf",
	}
	for in, want := range cases {
		if got := CleanName(in); got != want {
			t.Errorf("CleanName(%q) = %q, want %q", in, got, want)
		}
	}
	long := strings.Repeat("я", 500) + ".pdf"
	got := CleanName(long)
	if n := len([]rune(got)); n != MaxNameRunes {
		t.Fatalf("long name has %d runes, want %d", n, MaxNameRunes)
	}
	if !strings.HasSuffix(got, ".pdf") {
		t.Fatalf("long name lost its extension: %q", got)
	}
}

func TestContentDisposition(t *testing.T) {
	got := ContentDisposition(`Договор "1"; 50%.pdf`)
	if !strings.HasPrefix(got, `attachment; filename="_______ _1__ 50_.pdf"; filename*=UTF-8''`) {
		t.Fatalf("unexpected header: %s", got)
	}
	if strings.ContainsAny(got[strings.Index(got, "filename*="):], " \"") {
		t.Fatalf("filename* must be percent-encoded: %s", got)
	}
}
