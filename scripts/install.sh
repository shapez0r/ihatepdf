#!/usr/bin/env sh
# Installs a locally built ihatepdf binary as a systemd service on any Linux
# host or VM.  Usage:  make build && sudo ./scripts/install.sh [path/to/ihatepdf]
set -eu

BIN="${1:-./bin/ihatepdf}"
[ -x "$BIN" ] || { echo "binary not found: $BIN (run 'make build' first)" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

install -m 0755 "$BIN" /usr/local/bin/ihatepdf
install -d -m 0755 /etc/ihatepdf
[ -f /etc/ihatepdf/ihatepdf.env ] || cat > /etc/ihatepdf/ihatepdf.env <<'ENV'
# ihatepdf settings (see README). Restart the service after changes.
IHATEPDF_ALLOW_SIGNUP=true
IHATEPDF_SIGNUP_CIDRS=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,127.0.0.0/8,fc00::/7,fe80::/10,::1/128
IHATEPDF_COOKIE_SECURE=false
ENV
install -m 0644 "$(dirname "$0")/../deploy/systemd/ihatepdf.service" /etc/systemd/system/ihatepdf.service
systemctl daemon-reload
systemctl enable --now ihatepdf
echo "ihatepdf is running on port 8081. Data: /var/lib/ihatepdf  Config: /etc/ihatepdf/ihatepdf.env"
