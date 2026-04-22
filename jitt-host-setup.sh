#!/usr/bin/env bash
# jitt-host-setup.sh — Junk in the Trunk host prep
# Run once as root on the Docker/Podman host before first launch.

set -euo pipefail

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GRN}[+]${NC} $*"; }
warn() { echo -e "${YLW}[!]${NC} $*"; }
die()  { echo -e "${RED}[✗]${NC} $*"; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root: sudo ./jitt-host-setup.sh"

# ── 1. Blacklist DVB driver (conflicts with rtl-sdr) ─────────────────────────
BLACKLIST=/etc/modprobe.d/blacklist-rtlsdr.conf
if [[ ! -f "$BLACKLIST" ]]; then
  info "Blacklisting DVB kernel modules"
  cat > "$BLACKLIST" <<'CONF'
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830
CONF
  modprobe -r dvb_usb_rtl28xxu 2>/dev/null || true
  info "Blacklist written — replug dongles if already inserted"
else
  info "DVB blacklist already present — skipping"
fi

# ── 2. udev rules ─────────────────────────────────────────────────────────────
UDEV=/etc/udev/rules.d/20-rtlsdr.rules
info "Writing udev rules → $UDEV"
cat > "$UDEV" <<'CONF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", MODE="0666", GROUP="plugdev"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", MODE="0666", GROUP="plugdev"
CONF
udevadm control --reload-rules
udevadm trigger
info "udev rules applied"

# ── 3. Enumerate dongles and print serials ────────────────────────────────────
echo ""
info "Scanning for RTL-SDR dongles..."
if command -v rtl_test &>/dev/null; then
  rtl_test -t 2>&1 | grep -E "Found|Serial|device|Index" || true
  echo ""
  warn "Set unique serials before first run:"
  warn "  rtl_eeprom -d 0 -s TRUNK0 && rtl_eeprom -d 1 -s TRUNK1"
  warn "Then update device fields in config/trunk-recorder.json accordingly."
else
  warn "rtl_test not found — install rtl-sdr to enumerate dongle serials"
  warn "  Debian/Ubuntu: apt install rtl-sdr"
fi

# ── 4. .env setup ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  warn ".env not found — copying .env.example"
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  warn "Set DB_PASSWORD in .env before starting"
fi

echo ""
info "Host setup complete. Next steps:"
echo "  1. Set dongle serials:  rtl_eeprom -d 0 -s TRUNK0"
echo "  2. Edit config/trunk-recorder.json — set sysId and control_channel_list"
echo "  3. Drop your RadioReference CSV into config/talkgroups/"
echo "  4. Set DB_PASSWORD in .env"
echo "  5. podman compose up -d   (or: docker compose up -d)"
echo "  6. UI: http://localhost:8080"
