# ihatepdf

**ihatepdf** is an open-source, self-hosted set of PDF tools in the spirit of
ilovepdf.com: merge, split, organize, sign and fill in PDFs from any browser on
your network — made to work well on an iPad with the Apple Pencil. It is built
exactly like its sibling app **eurofish** (Go, Fiber, SQLite/MariaDB,
Valkey, vanilla JS UI embedded in one static binary) and listens on port
**8081**, so both can run on the same machine (eurofish keeps 8080).

All PDF processing happens **in the browser** with the bundled
[pdf-lib](https://pdf-lib.js.org/) and [pdf.js](https://mozilla.github.io/pdf.js/)
libraries (served by the binary, no CDN). Documents never leave the device
unless you save them to **My files** on your server.

### Tools

- ✎ **Fill in & annotate** — fill in PDF form fields (text, checkboxes, radio buttons, drop-downs) and add a notes layer: pen, highlighter, text notes, eraser, undo/redo, zoom. Then save everything into the PDF.
- ✍ **Sign PDF** — draw, type or upload your signature (white paper becomes transparent), place it anywhere or into a signature field, move and resize it; signatures can be remembered on the device
- ⊞ **Merge PDF** — combine several PDFs in the order you choose
- ✂ **Split PDF** — by page ranges (`1-3, 5, 8-`, optionally into one file), every N pages, or every page
- ▦ **Organize PDF** — page thumbnails: reorder, rotate, delete
- ⌫ **Remove pages**, ↻ **Rotate PDF** (all or some pages)
- ⇲ **Compress PDF** — lossless repack, or re-render pages as images (great for scans)
- \# **Page numbers** — 6 positions, formats such as “Page 1 of 9”, start number and page
- ≋ **Watermark** — text, size, angle, opacity, colour
- ▣ **Image to PDF** — JPG, PNG, HEIC (on Apple devices), WebP…; EXIF rotation respected; A4/Letter/fit, margins
- ◩ **PDF to image** — every page as JPG or PNG (72/150/300 dpi)
- 📁 **My files** — results can be saved on the server per user (upload, rename, download, open in the editor, use in any tool, “Update in My files” after editing); storage quota per user
- Multiple results come as a ZIP; on iPhone/iPad **Share…** opens the share sheet (Save to Files, Mail, …) when served over HTTPS
- Non-Latin text works everywhere (Cyrillic, Greek, CJK, …): form values, notes, watermarks and page numbers
- 🎨 The same colour themes as eurofish, 🌐 English, Russian and Spanish UI (follows the device language)

### iPad and Apple Pencil

Open the editor (**Fill in & annotate** or **Sign PDF**), pick **Pen**,
**Marker** or **Text** and write. As soon as the Apple Pencil touches the
screen, **Pencil only** switches on: the Pencil draws (with pressure), fingers
scroll the pages and a resting palm is ignored. Tap **Fill** to type into the
form fields of the PDF. **Save** writes the field values into the PDF form
(optionally flattened) and burns the notes layer into the pages; you can
download it, share it, or keep it in My files.

Tip: add the page to the home screen (Share → Add to Home Screen) for a
full-screen app.

### Quick start (home laptop / home-lab PC)

#### Option A — Docker (recommended)

    cp .env.example .env        # optional: restrict sign-up to your LAN, etc.
    docker compose up -d --build

Open http://<ip-of-this-machine>:8081/ihatepdf from any device on your home network,
click **Create account**, and start working with PDFs. Data (accounts and My
files) lives in the `ihatepdf-data` volume (a single SQLite file).

#### Option B — plain binary (Go 1.23+)

    make build                  # -> bin/ihatepdf (static, CGO-free)
    ./bin/ihatepdf              # listens on :8081 (UI at /ihatepdf), stores data in ./data

Install it as a hardened systemd service on any Linux machine or VM:

    sudo ./scripts/install.sh   # binary -> /usr/local/bin, data -> /var/lib/ihatepdf

Find your machine's LAN address with `ip addr` (Linux), `ipconfig` (Windows)
or `ipconfig getifaddr en0` (macOS) and allow TCP 8081 in its firewall.

### Updating: recompile and restart for a new version

Your data is kept across updates (Docker volume, `./data` or
`/var/lib/ihatepdf`), and database migrations run automatically when the new
version starts. Back up the SQLite file first if you want to be safe, e.g.
`cp data/ihatepdf.db data/ihatepdf.db.bak` (binary) or
`docker compose cp ihatepdf:/data/ihatepdf.db ./ihatepdf.db.bak` (Docker).

First put the new source in place (`git pull`, or extract the new archive over
the old folder), then use the commands for the way you run ihatepdf:

**Docker (single node)** — rebuild the image and recreate the container:

    docker compose up -d --build
    docker compose logs -f ihatepdf     # optional: watch it start (Ctrl+C to stop watching)

**Docker (scaled-out stack)**:

    docker compose -f compose.scale.yaml up -d --build

**Plain binary** — stop the running server (Ctrl+C in its terminal), then:

    make build && ./bin/ihatepdf        # or simply: make run

**systemd service** — rebuild, replace the installed binary and restart:

    make build
    sudo install -m 0755 bin/ihatepdf /usr/local/bin/ihatepdf
    sudo systemctl restart ihatepdf
    systemctl status ihatepdf           # should say "active (running)"

**Kubernetes** — build and push a new image (`make docker`, then tag/push to your
registry) and run `kubectl rollout restart deployment/ihatepdf`.

Finally reload the page in your browser with **Ctrl+F5** (**Cmd+Shift+R** on
macOS). You can check which version is running with `./bin/ihatepdf version`
or by opening `http://<server>:8081/healthz`.

### Deployment options

| Target | How | Storage / cache |
|---|---|---|
| Laptop, home lab | `docker compose up -d --build` or `make run` | SQLite file + in-process cache |
| Any Linux VM / bare metal | `sudo ./scripts/install.sh` (systemd) | SQLite file + in-process cache |
| MicroVM (Firecracker, Cloud Hypervisor) | `make rootfs` → `dist/ihatepdf-rootfs.ext4`, see `deploy/microvm/` | SQLite inside the rootfs (or MariaDB) |
| Scaled-out containers | `docker compose -f compose.scale.yaml up -d --build` | MariaDB + Valkey, nginx load balancer, 3 replicas |
| Kubernetes / cloud | `deploy/k8s/ihatepdf.yaml` | Managed MariaDB/MySQL + Valkey/Redis |

The container image is built `FROM scratch`: it contains only the ihatepdf
binary and CA certificates, runs as a non-root user and has a built-in
`HEALTHCHECK` (`ihatepdf healthcheck`).

### Configuration

Everything is configured through environment variables; all are optional for
a single node.

| Variable | Default | Description |
|---|---|---|
| `IHATEPDF_ADDR` | `:8081` | Listen address (all interfaces → reachable from the LAN) |
| `IHATEPDF_BASE_PATH` | `/ihatepdf` | URL prefix (`/` = serve at the root), e.g. `/ihatepdf`, to serve the app at `http://<server>:8080/ihatepdf/` behind a reverse proxy shared with eurofish (see `deploy/nginx/shared-8080.conf`) |
| `IHATEPDF_DATA_DIR` | `./data` (`/data` in the container) | Directory for the SQLite database |
| `IHATEPDF_DB_DRIVER` | `sqlite` | `sqlite` or `mariadb` (alias `mysql`) |
| `IHATEPDF_DB_DSN` | `file:<data dir>/ihatepdf.db` | e.g. `user:pass@tcp(host:3306)/ihatepdf?charset=utf8mb4` for MariaDB |
| `IHATEPDF_CACHE_URL` | `memory` | `memory` or `redis://host:6379/0` (Valkey or Redis; `valkey://` also accepted) |
| `IHATEPDF_ALLOW_SIGNUP` | `true` | Allow self-service account creation |
| `IHATEPDF_SIGNUP_CIDRS` | *(empty = anyone)* | Comma-separated networks allowed to sign up, e.g. `192.168.0.0/16,10.0.0.0/8` |
| `IHATEPDF_SESSION_TTL` | `720h` | Login session lifetime |
| `IHATEPDF_COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `IHATEPDF_PROXY_HEADER` | *(empty)* | Client-IP header when behind a trusted reverse proxy, e.g. `X-Forwarded-For` |
| `IHATEPDF_LOG_REQUESTS` | `true` | Access log on stdout |
| `IHATEPDF_MAX_FILE_MB` | `50` | Largest PDF that can be saved to My files (1–1024) |
| `IHATEPDF_QUOTA_MB` | `2048` | Space in My files per user (`0` = unlimited) |

With MariaDB, `max_allowed_packet` must be larger than `IHATEPDF_MAX_FILE_MB`
(`compose.scale.yaml` sets 256M). Behind nginx, raise `client_max_body_size`
accordingly (`deploy/nginx/nginx.conf` uses 64m).

### Commands

    ihatepdf serve        # default: migrate the database and start the server
    ihatepdf migrate      # only apply database migrations, then exit
    ihatepdf healthcheck  # exit 0 if the local server answers /healthz
    ihatepdf version

### Development

    make run      # build and start on :8081
    make test     # unit tests

The web UI is plain HTML/CSS/JavaScript in `web/static/` (no build step) and is
embedded into the binary with `go:embed`. Rebuild the binary after editing it.
pdf-lib and pdf.js are vendored in `web/static/vendor/`.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, the API and
the scaling model.

### What is not included

Converting Office documents (Word, Excel, PowerPoint) to or from PDF, OCR and
password protection/unlocking need heavy server-side engines (LibreOffice,
Tesseract, qpdf) that do not fit a single static binary, so they are not part
of ihatepdf. Password-protected PDFs cannot be opened.

### License

MIT — see [LICENSE](LICENSE). Bundled third-party code: pdf-lib (MIT, see
`web/static/vendor/pdf-lib.LICENSE.md`) and pdf.js (Apache-2.0, see
`web/static/vendor/pdfjs/LICENSE`, including its fonts and decoders licences).
