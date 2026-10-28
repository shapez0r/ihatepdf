## ihatepdf architecture

ihatepdf uses the same architecture as eurofish: one static Go binary with the
HTTP API, the embedded web UI, schema migrations and background jobs.

### Goals

- **Self-sufficient** — one static binary contains the HTTP server, API, web
  UI (including the PDF libraries), schema migrations and background jobs. No
  runtime, interpreter or separate frontend server is needed.
- **Private by default** — PDFs are processed in the browser; the server only
  stores files the user explicitly saves to My files.
- **Scale down** — on a laptop it needs nothing but a writable directory
  (SQLite + in-process cache).
- **Scale up** — the server is stateless; point every replica at the same
  MariaDB and Valkey and put any load balancer in front.
- **Portable** — the same artifact runs as a FROM scratch container, a
  systemd service, a Kubernetes pod or PID 1 inside a microVM.

### Stack

| Concern | Choice | Why |
|---|---|---|
| Language | Go 1.23 | Fast, single static binary, tiny memory footprint, trivial cross-compilation |
| HTTP | Fiber v2 (fasthttp) | Very fast, Express-like routing, batteries-included middleware |
| Database (single node) | SQLite via modernc.org/sqlite | Pure Go → `CGO_ENABLED=0` static binary; WAL mode for concurrent reads |
| Database (multi node) | MariaDB / MySQL | Open source, shared state for many replicas |
| Cache | in-process or Valkey/Redis | Valkey shares session lookups across replicas |
| UI | Vanilla HTML/CSS/JS, embedded | No build toolchain, strict CSP, works offline from the binary |
| PDF engine | pdf-lib 1.17 (create/modify) + pdf.js 5 legacy build (render), vendored | Runs in every modern browser incl. iPad Safari; no server CPU per document |

### Layout

    cmd/ihatepdf/          entry point: serve | migrate | healthcheck | version
    internal/config/       environment configuration
    internal/db/           connection handling + embedded, versioned migrations per dialect
    internal/store/        data access (portable SQL for SQLite and MariaDB)
    internal/pdfmeta/      pure helpers: PDF upload check, safe file names (unit tested)
    internal/cache/        Cache interface: memory and Valkey/Redis backends
    internal/auth/         password hashing, session tokens, identity-provider interface
    internal/server/       Fiber app, middleware, HTTP handlers
    web/static/            single-page UI, embedded with go:embed
    web/static/vendor/     pdf-lib and pdf.js (+ worker, cmaps, standard fonts, wasm decoders)
    deploy/                nginx, systemd, microVM rootfs, Kubernetes

### Where the PDF work happens

| Tool | Browser implementation |
|---|---|
| Merge, split, remove, organize, rotate | pdf-lib `copyPages` / `setRotation` |
| Page numbers, watermark | pdf-lib `drawText` (Helvetica); text Helvetica cannot encode is drawn as an image rendered with the device fonts. Page `/Rotate` is taken into account so text is placed as the page is displayed. |
| Compress | lossless: pdf-lib re-save with object streams; raster: pdf.js renders each page to JPEG, pdf-lib builds a new PDF |
| Image to PDF | browser decodes the image (EXIF orientation, HEIC on Apple devices) to JPEG/PNG → pdf-lib |
| PDF to image | pdf.js renders pages to canvas → JPEG/PNG (ZIP for many) |
| Fill in & annotate, sign | pdf.js renders pages (lazily, canvases released off-screen to respect iPad memory limits) with `AnnotationMode.ENABLE_FORMS`; form widgets become HTML inputs at their positions; a canvas notes layer per page records pen/highlighter/text/signature items |

**Saving from the editor** loads the original bytes with pdf-lib and:

1. writes changed field values into the AcroForm (text, checkbox, radio,
   drop-down, list) and regenerates their appearances; when Helvetica cannot
   show a value (e.g. Cyrillic), the field appearance becomes an image of the
   value rendered with the device fonts, so every viewer shows it; optional
   flattening;
2. renders each page's notes layer at up to 3× resolution into a transparent
   PNG, rotated back into unrotated page space, and draws it over the page's
   crop box.

Undo/redo works on immutable per-page item lists. Pointer input: the Apple
Pencil (`pointerType: "pen"`, `touchType: "stylus"`) is detected
automatically and switches to "Pencil only" (fingers scroll natively, the
Pencil draws with pressure); otherwise fingers draw. Touches the editor
handles call `preventDefault()` on `touchstart`, all others scroll natively.

### Data model

Timestamps are unix seconds and IDs are application-generated UUIDs. The SQL
is identical on SQLite and MariaDB.

- `users` — e-mail, display name, bcrypt password hash (nullable for future
  external-only accounts)
- `auth_identities` — (provider, subject) → user; reserved for Google/Apple
- `sessions` — SHA-256 hash of the opaque session token, expiry
- `documents` — My files: owner, name, size, page count, SHA-256, the PDF
  bytes (`BLOB` / `LONGBLOB`), created/updated. Listing never reads the bytes.

Storing files in the database keeps replicas stateless (any replica can serve
any file) and makes backups a single database dump.

### Scaling model

- **Stateless replicas** — sessions and files live in the database; session
  lookups are cached for 60 s (memory or Valkey). Any replica can serve any request.
- **Migrations** run on start-up. On MariaDB a `GET_LOCK` makes concurrent
  replica start-ups safe; on SQLite immediate transactions serialise them.
- **Health** — `/healthz` (process up) and `/readyz` (database and cache
  reachable) for load balancers and orchestrators.
- **Graceful shutdown** on SIGTERM with a 15 s drain.
- **Rate limiting** of sign-in/sign-up is per replica (in-memory).

### Security

- bcrypt (cost 12) password hashes; constant-time-ish login for unknown users
- Opaque 256-bit session tokens in HttpOnly, SameSite=Lax cookies; only
  their SHA-256 hash is stored
- State-changing requests must be JSON, or `application/pdf` with an
  `X-Requested-With` header (uploads); both block cross-site form posts
- Uploads are size-limited (`IHATEPDF_MAX_FILE_MB`), checked for a PDF header
  and end marker, and counted against a per-user quota
- Every file is scoped to its owner in SQL (`WHERE id = ? AND owner_id = ?`)
- Strict Content-Security-Policy (`'self'` only; `'wasm-unsafe-eval'` for the
  pdf.js image decoders, no `eval`), `X-Frame-Options: DENY`, nosniff
- Optional sign-up restriction to given networks (`IHATEPDF_SIGNUP_CIDRS`)
- Container runs as non-root from an empty (scratch) image

### HTTP API

All endpoints are JSON under `/api` unless noted. Errors are `{"error": "message"}`.

| Method | Path | Notes |
|---|---|---|
| GET | `/config` | `{signup_enabled, version, max_file_bytes, quota_bytes}` |
| POST | `/auth/signup` | `{email, password, display_name}` → user + session cookie |
| POST | `/auth/login` | `{email, password}` → user + session cookie |
| POST | `/auth/logout` | |
| GET | `/me` | current user |
| GET | `/documents` | `{documents: [{id, name, size, pages, sha256, created_at, updated_at}], used_bytes, quota_bytes, max_file_bytes}` |
| POST | `/documents?name=&pages=` | raw `application/pdf` body + `X-Requested-With` → 201 document |
| GET / PATCH / DELETE | `/documents/:id` | metadata / rename `{name}` / delete |
| GET | `/documents/:id/file` | the PDF (`application/pdf`, `Content-Disposition: attachment`) |
| PUT | `/documents/:id/file?pages=` | replace the bytes (raw `application/pdf` + `X-Requested-With`) |
| GET | `/healthz`, `/readyz` | liveness / readiness (outside `/api`) |
