#!/usr/bin/env bash
# ez_setup.sh — install EzSolver (CF Turnstile solver via real Chrome + nodriver)
#
# EzSolver runs a real Google Chrome via `nodriver` (raw CDP, not Playwright's
# Chromium and not patchright). Cloudflare has not fingerprinted this stack,
# so Turnstile widgets solve normally. It listens on http://127.0.0.1:8191
# and returns tokens over HTTP.
#
# Prereqs: vps_setup.sh --install has already run (Python 3.12 venv, Xvfb).
#
# Usage:
#   bash ez_setup.sh --install    # install EzSolver + Google Chrome + systemd service
#   bash ez_setup.sh --start      # start the service manually (no systemd)
#   bash ez_setup.sh --test       # POST a test request to /health and /solve
#   bash ez_setup.sh --status     # show service status
#
# Idempotent: safe to re-run.

set -euo pipefail

# ------------------------------------------------------------------
# Config
# ------------------------------------------------------------------
INSTALL_DIR="${INSTALL_DIR:-$HOME/xserver-auto-renew}"
EZ_DIR="${EZ_DIR:-$INSTALL_DIR/EzSolver}"
EZ_REPO="${EZ_REPO:-https://github.com/ismoiloffS/EzSolver.git}"
EZ_PORT="${EZ_PORT:-8191}"
EZ_MAX_WORKERS="${EZ_MAX_WORKERS:-2}"   # 2 workers = ~1GB RAM; enough for 1/day cron
EZ_PROFILE_DIR="${EZ_PROFILE_DIR:-/tmp/ts_profile}"
VENV="${VENV:-$INSTALL_DIR/.venv}"
SYSTEMD_UNIT="/etc/systemd/system/ezsolver.service"

# ------------------------------------------------------------------
# Utilities
# ------------------------------------------------------------------
c_reset='\033[0m'; c_bold='\033[1m'; c_green='\033[32m'; c_yellow='\033[33m'; c_red='\033[31m'
log()   { printf "${c_bold}${c_green}==>${c_reset} %s\n" "$*"; }
warn()  { printf "${c_bold}${c_yellow}==>${c_reset} %s\n" "$*" >&2; }
error() { printf "${c_bold}${c_red}==>${c_reset} %s\n" "$*" >&2; }
have()  { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else
  if have sudo; then SUDO="sudo"; else
    error "Need root or sudo."; exit 1
  fi
fi

# ------------------------------------------------------------------
# 1) Install Google Chrome (real, not Chromium)
# ------------------------------------------------------------------
install_chrome() {
  local arch
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) ;;
    *)
      error "Google Chrome for Linux is x86_64-only. On $arch, EzSolver cannot use real Chrome."
      error "Fallback: install chromium-browser and set CHROME_PATH=/usr/bin/chromium-browser."
      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium-browser 2>/dev/null \
        || $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium 2>/dev/null \
        || warn "Could not install chromium either. Manual install needed."
      return 0
      ;;
  esac

  if [ -x /usr/bin/google-chrome ] || [ -x /usr/bin/google-chrome-stable ]; then
    log "Google Chrome already installed"
    return 0
  fi

  log "Installing Google Chrome (stable, x86_64)..."
  # Modern keyring approach (apt-key is deprecated on Ubuntu 22.04+).
  $SUDO install -d -m 0755 /etc/apt/keyrings /usr/share/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | $SUDO gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    | $SUDO tee /etc/apt/sources.list.d/google-chrome.list >/dev/null

  # Refresh only the google-chrome list (avoid touching broken 3rd-party repos).
  $SUDO apt-get update -qq \
    -o Dir::Etc::sourcelist="sources.list.d/google-chrome.list" \
    -o Dir::Etc::sourceparts="-" \
    -o APT::Get::List-Cleanup="0" || true
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends google-chrome-stable

  if ! have google-chrome && ! have google-chrome-stable; then
    error "google-chrome install failed."; exit 1
  fi
  log "Google Chrome installed at: $(command -v google-chrome-stable || command -v google-chrome)"
}

# ------------------------------------------------------------------
# 2) Clone / update EzSolver + install nodriver into our venv
# ------------------------------------------------------------------
install_ezsolver() {
  # Sanity: venv must exist.
  if [ ! -x "$VENV/bin/python" ]; then
    error "Venv not found at $VENV. Run vps_setup.sh --install first."
    exit 1
  fi

  if [ ! -d "$EZ_DIR/.git" ]; then
    log "Cloning EzSolver into $EZ_DIR"
    git clone --depth 1 "$EZ_REPO" "$EZ_DIR"
  else
    log "Updating existing EzSolver at $EZ_DIR"
    git -C "$EZ_DIR" fetch --depth 1 origin
    git -C "$EZ_DIR" reset --hard "origin/$(git -C "$EZ_DIR" symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@')" 2>/dev/null \
      || git -C "$EZ_DIR" reset --hard origin/main
  fi

  log "Installing nodriver into venv..."
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  pip install --quiet --upgrade nodriver
  deactivate
}

# ------------------------------------------------------------------
# 3) Install systemd service (auto-start EzSolver on boot)
# ------------------------------------------------------------------
install_systemd_service() {
  if ! have systemctl; then
    warn "systemctl not available; skipping systemd unit install."
    warn "You can start the service manually with:  bash $0 --start"
    return 0
  fi

  local chrome_path
  chrome_path=$(command -v google-chrome-stable || command -v google-chrome || command -v chromium-browser || command -v chromium || echo "")
  if [ -z "$chrome_path" ]; then
    error "No Chrome/Chromium binary found; cannot write systemd unit."; exit 1
  fi

  log "Writing systemd unit at $SYSTEMD_UNIT"
  $SUDO tee "$SYSTEMD_UNIT" >/dev/null <<EOF
[Unit]
Description=EzSolver — Cloudflare Turnstile solver HTTP service (real Chrome + nodriver)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
Group=$(id -gn)
WorkingDirectory=$EZ_DIR
Environment=PORT=$EZ_PORT
Environment=MAX_WORKERS=$EZ_MAX_WORKERS
Environment=CHROME_PATH=$chrome_path
Environment=TS_PROFILE_DIR=$EZ_PROFILE_DIR
# EzSolver starts its own Xvfb on :99 if DISPLAY isn't set.
ExecStart=$VENV/bin/python $EZ_DIR/service.py
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/ezsolver.log
StandardError=append:/var/log/ezsolver.log

[Install]
WantedBy=multi-user.target
EOF

  $SUDO touch /var/log/ezsolver.log
  $SUDO chown "$(id -un)":"$(id -gn)" /var/log/ezsolver.log
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable ezsolver.service
  $SUDO systemctl restart ezsolver.service
  sleep 2

  if $SUDO systemctl is-active --quiet ezsolver.service; then
    log "ezsolver.service is active. Logs: sudo tail -f /var/log/ezsolver.log"
  else
    warn "ezsolver.service failed to start. See:  sudo systemctl status ezsolver.service"
    $SUDO systemctl status ezsolver.service --no-pager || true
  fi
}

# ------------------------------------------------------------------
# do_install / do_start / do_test / do_status
# ------------------------------------------------------------------
do_install() {
  install_chrome
  install_ezsolver
  install_systemd_service

  log "EzSolver install complete."
  log "Next steps:"
  echo "    1. Test:   bash $0 --test"
  echo "    2. Health: curl -s http://127.0.0.1:$EZ_PORT/health"
  echo "    3. Logs:   sudo tail -f /var/log/ezsolver.log"
}

do_start() {
  # Manual (non-systemd) start.
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  cd "$EZ_DIR"
  local chrome_path
  chrome_path=$(command -v google-chrome-stable || command -v google-chrome || command -v chromium-browser || command -v chromium || echo "")
  export CHROME_PATH="$chrome_path"
  export PORT="$EZ_PORT"
  export MAX_WORKERS="$EZ_MAX_WORKERS"
  export TS_PROFILE_DIR="$EZ_PROFILE_DIR"
  log "Starting EzSolver on port $EZ_PORT (Chrome: $chrome_path)"
  exec python service.py
}

do_test() {
  log "GET /health"
  if ! curl -fsS "http://127.0.0.1:$EZ_PORT/health"; then
    error "Service not reachable on port $EZ_PORT. Is it running?"
    error "Start with: sudo systemctl start ezsolver.service   (or: bash $0 --start)"
    exit 1
  fi
  echo

  log "POST /solve  (using CF public demo sitekey — should succeed in <10s)"
  # 1x00000000000000000000AA is Cloudflare's official demo sitekey that always passes.
  curl -sS -X POST "http://127.0.0.1:$EZ_PORT/solve" \
    -H "Content-Type: application/json" \
    -d '{"sitekey":"1x00000000000000000000AA","siteurl":"https://example.com/","timeout":30}'
  echo
}

do_status() {
  if have systemctl; then
    $SUDO systemctl status ezsolver.service --no-pager || true
  fi
  echo
  log "Health check:"
  curl -fsS "http://127.0.0.1:$EZ_PORT/health" || echo "(service not reachable)"
  echo
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [--install|--start|--test|--status|--help]

  --install   Install Chrome + EzSolver + nodriver + systemd service
  --start     Run EzSolver in the foreground (no systemd) — for debugging
  --test      Hit /health and /solve with CF's public demo sitekey
  --status    Show systemd status + /health
  --help      Show this help

Env overrides:
  INSTALL_DIR     (default: \$HOME/xserver-auto-renew)
  EZ_DIR          (default: \$INSTALL_DIR/EzSolver)
  EZ_PORT         (default: 8191)
  EZ_MAX_WORKERS  (default: 2)
  EZ_PROFILE_DIR  (default: /tmp/ts_profile)
EOF
}

mode="${1:---install}"
case "$mode" in
  --install) do_install ;;
  --start)   do_start ;;
  --test)    do_test ;;
  --status)  do_status ;;
  --help|-h) usage ;;
  *) usage; exit 1 ;;
esac
