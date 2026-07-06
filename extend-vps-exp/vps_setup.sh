#!/usr/bin/env bash
# vps_setup.sh — self-installing runner for Xserver VPS auto-renew
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/gamelist1990/Debug/main/extend-vps-exp/vps_setup.sh | bash
#   # or after clone:
#   bash extend-vps-exp/vps_setup.sh          # install + run
#   bash extend-vps-exp/vps_setup.sh --install # install only
#   bash extend-vps-exp/vps_setup.sh --run     # run only (assumes installed)
#   bash extend-vps-exp/vps_setup.sh --cron    # add crontab entry (daily 03:00 JST)
#
# Supports Debian/Ubuntu on x86_64 and aarch64 (arm64).
# Idempotent: safe to re-run any time; the script only installs what is missing.
#
# Note: There is no physical display on a headless VPS. We still need Xvfb,
# but running from a VPS IP (instead of Azure/GitHub Actions) plus a
# persistent Chromium profile gives CF Turnstile a better chance of trusting
# the request. This is not a guaranteed fix for CF under Xvfb, but is far
# more likely to work than a fresh ephemeral GitHub Actions runner.

set -euo pipefail

# ------------------------------------------------------------------
# Config (override via env vars)
# ------------------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/gamelist1990/Debug.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/xserver-auto-renew}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
TF_VERSION="${TF_VERSION:-2.19.0}"
CRON_TIME="${CRON_TIME:-0 3 * * *}"   # daily 03:00 (VPS local time)

SCRIPT_ABS_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"

# ------------------------------------------------------------------
# Utilities
# ------------------------------------------------------------------
c_reset='\033[0m'; c_bold='\033[1m'; c_green='\033[32m'; c_yellow='\033[33m'; c_red='\033[31m'
log()   { printf "${c_bold}${c_green}==>${c_reset} %s\n" "$*"; }
warn()  { printf "${c_bold}${c_yellow}==>${c_reset} %s\n" "$*" >&2; }
error() { printf "${c_bold}${c_red}==>${c_reset} %s\n" "$*" >&2; }
have()  { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  if have sudo; then
    SUDO="sudo"
  else
    error "Neither root nor sudo available. Please re-run as root or install sudo."
    exit 1
  fi
fi

detect_arch() {
  local a
  a=$(uname -m)
  case "$a" in
    x86_64|amd64)   echo "x86_64" ;;
    aarch64|arm64)  echo "aarch64" ;;
    *) error "Unsupported architecture: $a"; exit 1 ;;
  esac
}

detect_pkg_mgr() {
  if have apt-get;   then echo apt;    return; fi
  if have dnf;       then echo dnf;    return; fi
  if have yum;       then echo yum;    return; fi
  if have apk;       then echo apk;    return; fi
  if have pacman;    then echo pacman; return; fi
  echo unknown
}

install_system_packages() {
  local mgr=$1
  # Package name mapping (Debian names as base).
  local pkgs=(git python3 python3-pip python3-venv xvfb xdotool ffmpeg curl ca-certificates)
  case "$mgr" in
    apt)
      # Third-party PPAs (e.g. packagecloud speedtest-cli with invalid codename)
      # may return non-zero from `apt-get update`. We tolerate that as long as
      # the main Ubuntu/Debian archives still refresh, since the actual install
      # step below will fail loudly if any of our packages are truly missing.
      if ! $SUDO apt-get update -qq 2>/tmp/apt-update.err; then
        warn "apt-get update had errors (some third-party repos may be broken):"
        warn "$(tail -n 3 /tmp/apt-update.err)"
        warn "Continuing; install step will fail if base packages are unreachable."
      fi
      $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${pkgs[@]}"
      ;;
    dnf|yum)
      # Fedora/RHEL: python3-venv is bundled with python3; xvfb is xorg-x11-server-Xvfb.
      $SUDO "$mgr" install -y git python3 python3-pip xorg-x11-server-Xvfb xdotool ffmpeg curl ca-certificates
      ;;
    apk)
      $SUDO apk add --no-cache git python3 py3-pip py3-virtualenv xvfb xdotool ffmpeg curl ca-certificates
      ;;
    pacman)
      $SUDO pacman -Sy --noconfirm --needed git python python-pip xorg-server-xvfb xdotool ffmpeg curl ca-certificates
      ;;
    *)
      error "Unsupported package manager. Please install manually: ${pkgs[*]}"
      exit 1
      ;;
  esac
}

# ------------------------------------------------------------------
# Install steps
# ------------------------------------------------------------------
do_install() {
  local arch mgr
  arch=$(detect_arch)
  mgr=$(detect_pkg_mgr)
  log "Architecture: $arch"
  log "Package manager: $mgr"
  log "Install dir: $INSTALL_DIR"

  # ---- 1. System packages ----
  local need=0
  for cmd in git python3 Xvfb xdotool ffmpeg curl; do
    if ! have "$cmd"; then need=1; break; fi
  done
  if [ "$need" -eq 1 ]; then
    log "Installing system packages..."
    install_system_packages "$mgr"
  else
    log "System packages already present"
  fi

  # ---- 2. Repo checkout / update ----
  if [ ! -d "$INSTALL_DIR/.git" ]; then
    log "Cloning repo into $INSTALL_DIR"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  else
    log "Updating existing repo at $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --depth 1 origin main
    git -C "$INSTALL_DIR" reset --hard origin/main
  fi

  local APP_DIR="$INSTALL_DIR/extend-vps-exp"
  cd "$APP_DIR"

  # ---- 3. Python venv ----
  local VENV="$INSTALL_DIR/.venv"
  if [ ! -x "$VENV/bin/python" ]; then
    log "Creating Python venv at $VENV"
    $PYTHON_BIN -m venv "$VENV"
  else
    log "Python venv already present"
  fi
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  python -m pip install --quiet --upgrade pip

  # ---- 4. Python packages ----
  # tensorflow-cpu has wheels for both x86_64 and aarch64 Linux since 2.16.
  # If it fails on aarch64 for the pinned version, we fall back to the latest.
  log "Installing Python packages (may take several minutes)..."
  if ! pip install --quiet \
        "scrapling[fetchers]" playwright pillow "numpy<2.2" \
        "tensorflow-cpu==${TF_VERSION}"; then
    warn "Pinned tensorflow-cpu==${TF_VERSION} unavailable for this platform."
    warn "Falling back to latest tensorflow-cpu."
    pip install --quiet "scrapling[fetchers]" playwright pillow "numpy<2.2" tensorflow-cpu
  fi

  # ---- 5. Playwright browsers ----
  if [ ! -d "$HOME/.cache/ms-playwright" ] \
     || [ -z "$(find "$HOME/.cache/ms-playwright" -maxdepth 4 -name chrome -o -name chromium -o -name headless_shell 2>/dev/null | head -n1)" ]; then
    log "Installing Playwright Chromium (with system deps)..."
    # --with-deps requires root; if this fails (non-root without sudo policy),
    # we retry without --with-deps and rely on already-installed libs.
    if ! python -m playwright install --with-deps chromium 2>/dev/null; then
      python -m playwright install chromium
    fi
  else
    log "Playwright browsers already present"
  fi

  # Scrapling's optional stealth browser bundle.
  scrapling install >/dev/null 2>&1 || true

  # ---- 6. .env template ----
  if [ ! -f "$APP_DIR/.env" ]; then
    cat > "$APP_DIR/.env" <<'EOF'
# Xserver login credentials (required).
EMAIL=your-email@example.com
PASSWORD=your-password

# Optional HTTP/HTTPS proxy (helps if your VPS IP is CF-flagged).
# PROXY_SERVER=http://user:pass@host:port
EOF
    chmod 600 "$APP_DIR/.env"
    warn ".env template created at $APP_DIR/.env"
    warn "Edit it with your real credentials before the first run."
  else
    log ".env already exists"
  fi

  log "Install complete."
  log "Next steps:"
  echo "    1. Edit  $APP_DIR/.env"
  echo "    2. Test: bash $SCRIPT_ABS_PATH --run"
  echo "    3. Cron: bash $SCRIPT_ABS_PATH --cron"
}

# ------------------------------------------------------------------
# Run steps
# ------------------------------------------------------------------
do_run() {
  local APP_DIR="$INSTALL_DIR/extend-vps-exp"
  local VENV="$INSTALL_DIR/.venv"

  if [ ! -x "$VENV/bin/python" ] || [ ! -d "$APP_DIR" ]; then
    error "Not installed. Running install first."
    do_install
  fi

  cd "$APP_DIR"
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"

  # ---- Xvfb ----
  export DISPLAY="${DISPLAY:-:99}"
  if ! pgrep -f "Xvfb ${DISPLAY}" >/dev/null 2>&1; then
    log "Starting Xvfb on ${DISPLAY}"
    Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac -nolisten tcp >/tmp/xvfb.log 2>&1 &
    sleep 2
  else
    log "Xvfb already running on ${DISPLAY}"
  fi

  # ---- Mouse warm-up (helps CF Turnstile behavioral checks) ----
  xdotool mousemove 640 400 >/dev/null 2>&1 || true
  sleep 1
  xdotool mousemove 800 500 >/dev/null 2>&1 || true

  # ---- CAPTCHA model path ----
  local MODEL_PATH="$INSTALL_DIR/xserver_captcha.keras"
  if [ -f "$MODEL_PATH" ]; then
    export CAPTCHA_MODEL_PATH="$MODEL_PATH"
  fi

  # ---- Runtime env ----
  export HEADLESS=0
  export DEBUG_VIDEO="${DEBUG_VIDEO:-0}"
  export TF_CPP_MIN_LOG_LEVEL=2
  # Preserve Chromium profile between runs so CF learns to trust us.
  # (Scrapling/patchright honours this by default via user_data_dir.)
  export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

  # ---- Load .env (cron has a minimal env) ----
  if [ -f "$APP_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$APP_DIR/.env"
    set +a
  fi

  log "$(date -Is) starting main.py"
  python main.py
  local rc=$?
  log "$(date -Is) main.py exited with code $rc"
  return $rc
}

# ------------------------------------------------------------------
# Cron helper
# ------------------------------------------------------------------
do_cron() {
  local marker="# xserver-auto-renew (managed by vps_setup.sh)"
  local line="${CRON_TIME} bash ${SCRIPT_ABS_PATH} --run >> ${INSTALL_DIR}/cron.log 2>&1  ${marker}"

  # Read existing crontab (may be empty).
  local current
  current=$(crontab -l 2>/dev/null || true)

  if echo "$current" | grep -Fq "$marker"; then
    log "Cron entry already exists. Updating..."
    printf '%s\n' "$current" | grep -vF "$marker" > /tmp/.crontab.new
  else
    log "Adding new cron entry"
    printf '%s\n' "$current" > /tmp/.crontab.new
  fi
  printf '%s\n' "$line" >> /tmp/.crontab.new
  crontab /tmp/.crontab.new
  rm -f /tmp/.crontab.new

  log "Installed cron entry:"
  echo "    $line"
  log "View logs: tail -f ${INSTALL_DIR}/cron.log"
}

# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------
usage() {
  cat <<EOF
Usage: $(basename "$0") [--install|--run|--cron|--help]

Without arguments: install (if needed) then run.

  --install   Install/update dependencies only, do not run.
  --run       Run main.py (installs first if never installed).
  --cron      Register a daily cron job that calls this script with --run.
  --help      Show this help.

Env overrides:
  INSTALL_DIR   (default: \$HOME/xserver-auto-renew)
  REPO_URL      (default: https://github.com/gamelist1990/Debug.git)
  CRON_TIME     (default: '0 3 * * *')
  TF_VERSION    (default: 2.19.0)
EOF
}

mode="${1:-auto}"
case "$mode" in
  --install) do_install ;;
  --run)     do_run ;;
  --cron)    do_cron ;;
  --help|-h) usage ;;
  auto)      do_install; do_run ;;
  *) usage; exit 1 ;;
esac
