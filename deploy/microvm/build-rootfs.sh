#!/usr/bin/env bash
# Builds a tiny ext4 root filesystem for a microVM (Firecracker, Cloud
# Hypervisor, QEMU microvm). The static ihatepdf binary runs directly as PID 1:
# no distro, no init system, no package manager.
#
#   ./deploy/microvm/build-rootfs.sh [binary] [output.ext4] [size]
#
# Boot with kernel args such as:
#   console=ttyS0 reboot=k panic=1 rw init=/ihatepdf
#   ip=172.16.0.2::172.16.0.1:255.255.255.0::eth0:off
#   IHATEPDF_DATA_DIR=/data IHATEPDF_ADDR=:8081
# (the kernel passes unknown KEY=VALUE arguments to init as environment variables;
#  the guest kernel needs CONFIG_IP_PNP and CONFIG_DEVTMPFS_MOUNT, which the
#  Firecracker reference kernels have).
set -euo pipefail

BIN="${1:-bin/ihatepdf}"
OUT="${2:-dist/ihatepdf-rootfs.ext4}"
SIZE="${3:-512M}"

[ -x "$BIN" ] || { echo "binary not found: $BIN (run 'make build' first)" >&2; exit 1; }
command -v mkfs.ext4 >/dev/null || { echo "mkfs.ext4 (e2fsprogs) is required" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK"/{data,dev,proc,sys,tmp,etc/ssl/certs}
install -m 0755 "$BIN" "$WORK/ihatepdf"
if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
  cp /etc/ssl/certs/ca-certificates.crt "$WORK/etc/ssl/certs/"
fi
printf '127.0.0.1 localhost\n' > "$WORK/etc/hosts"
chmod 1777 "$WORK/tmp"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
truncate -s "$SIZE" "$OUT"
mkfs.ext4 -q -L ihatepdf -d "$WORK" "$OUT"
echo "rootfs written to $OUT"
echo "example Firecracker config: deploy/microvm/firecracker.json"
