package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"

	"ihatepdf/internal/auth"
	"ihatepdf/internal/pdfmeta"
	"ihatepdf/internal/store"
)

// maxPages is the largest page count accepted as metadata (sanity limit only;
// the client counts the pages, the server never parses PDF content).
const maxPages = 100_000

type documentList struct {
	Documents    []store.Document `json:"documents"`
	UsedBytes    int64            `json:"used_bytes"`
	QuotaBytes   int64            `json:"quota_bytes"`
	MaxFileBytes int64            `json:"max_file_bytes"`
}

func (s *Server) listDocuments(c *fiber.Ctx) error {
	user := currentUser(c)
	docs, err := s.store.ListDocuments(c.UserContext(), user.ID)
	if err != nil {
		return err
	}
	var used int64
	for _, d := range docs {
		used += d.Size
	}
	return c.JSON(documentList{Documents: docs, UsedBytes: used, QuotaBytes: s.cfg.QuotaBytes, MaxFileBytes: s.cfg.MaxFileBytes})
}

func (s *Server) getDocument(c *fiber.Ctx) error {
	d, err := s.store.Document(c.UserContext(), currentUser(c).ID, c.Params("id"))
	if err != nil {
		return err
	}
	return c.JSON(d)
}

// uploadedPDF validates the raw request body of an upload and returns it
// together with its page count (sent by the client as ?pages=).
func (s *Server) uploadedPDF(c *fiber.Ctx) ([]byte, int, error) {
	body := c.Body()
	if int64(len(body)) > s.cfg.MaxFileBytes {
		return nil, 0, fiber.NewError(fiber.StatusRequestEntityTooLarge,
			fmt.Sprintf("the file is too large (max %d MB)", s.cfg.MaxFileBytes>>20))
	}
	if err := pdfmeta.Check(body); err != nil {
		if errors.Is(err, pdfmeta.ErrTruncated) {
			return nil, 0, badRequest("the PDF file is incomplete")
		}
		return nil, 0, badRequest("the file is not a PDF")
	}
	pages := 0
	if raw := c.Query("pages"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 || n > maxPages {
			return nil, 0, badRequest("pages must be a whole number")
		}
		pages = n
	}
	// Fiber reuses the request buffer after the handler returns: keep a copy.
	content := make([]byte, len(body))
	copy(content, body)
	return content, pages, nil
}

func (s *Server) checkQuota(c *fiber.Ctx, exceptID string, size int64) error {
	if s.cfg.QuotaBytes <= 0 {
		return nil
	}
	used, err := s.store.UsedBytes(c.UserContext(), currentUser(c).ID, exceptID)
	if err != nil {
		return err
	}
	if used+size > s.cfg.QuotaBytes {
		return fiber.NewError(fiber.StatusInsufficientStorage,
			fmt.Sprintf("not enough space in My files (limit %d MB)", s.cfg.QuotaBytes>>20))
	}
	return nil
}

func hashHex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// createDocument saves an uploaded PDF (raw application/pdf body) to My files.
// The name is given as ?name=.
func (s *Server) createDocument(c *fiber.Ctx) error {
	content, pages, err := s.uploadedPDF(c)
	if err != nil {
		return err
	}
	if err := s.checkQuota(c, "", int64(len(content))); err != nil {
		return err
	}
	now := time.Now().Unix()
	d := &store.Document{
		ID:        auth.NewID(),
		Name:      pdfmeta.CleanName(c.Query("name")),
		Size:      int64(len(content)),
		Pages:     pages,
		SHA256:    hashHex(content),
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.store.CreateDocument(c.UserContext(), currentUser(c).ID, d, content); err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(d)
}

// replaceDocument overwrites the bytes of an existing file (e.g. after it was
// filled in, signed or annotated in the editor).
func (s *Server) replaceDocument(c *fiber.Ctx) error {
	user := currentUser(c)
	d, err := s.store.Document(c.UserContext(), user.ID, c.Params("id"))
	if err != nil {
		return err
	}
	content, pages, err := s.uploadedPDF(c)
	if err != nil {
		return err
	}
	if err := s.checkQuota(c, d.ID, int64(len(content))); err != nil {
		return err
	}
	d.Size = int64(len(content))
	d.Pages = pages
	d.SHA256 = hashHex(content)
	d.UpdatedAt = time.Now().Unix()
	if err := s.store.ReplaceDocument(c.UserContext(), user.ID, d, content); err != nil {
		return err
	}
	return c.JSON(d)
}

func (s *Server) downloadDocument(c *fiber.Ctx) error {
	d, content, err := s.store.DocumentContent(c.UserContext(), currentUser(c).ID, c.Params("id"))
	if err != nil {
		return err
	}
	c.Set(fiber.HeaderContentType, "application/pdf")
	c.Set(fiber.HeaderContentDisposition, pdfmeta.ContentDisposition(d.Name))
	c.Set("X-Document-Pages", strconv.Itoa(d.Pages))
	c.Set(fiber.HeaderETag, `"`+d.SHA256+`"`)
	return c.Send(content)
}

func (s *Server) renameDocument(c *fiber.Ctx) error {
	var in struct {
		Name string `json:"name"`
	}
	if err := c.BodyParser(&in); err != nil {
		return badRequest("invalid JSON body")
	}
	user := currentUser(c)
	name := pdfmeta.CleanName(in.Name)
	now := time.Now().Unix()
	if err := s.store.RenameDocument(c.UserContext(), user.ID, c.Params("id"), name, now); err != nil {
		return err
	}
	d, err := s.store.Document(c.UserContext(), user.ID, c.Params("id"))
	if err != nil {
		return err
	}
	return c.JSON(d)
}

func (s *Server) deleteDocument(c *fiber.Ctx) error {
	if err := s.store.DeleteDocument(c.UserContext(), currentUser(c).ID, c.Params("id")); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}
