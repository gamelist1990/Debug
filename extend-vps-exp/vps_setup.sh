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

# Fallback installer: portable, static-linked Python 3.12 from
# python-build-standalone (used by uv, ruff, etc.). Extracts to /opt/python-3.12
# and symlinks `python3.12` into /usr/local/bin.
# This works even on brand-new Ubuntu releases where no PPA has caught up.
install_python312_standalone() {
  local arch tag url tmp
  arch=$(uname -m)
  # See https://github.com/astral-sh/python-build-standalone/releases
  # We pin a known-good release tag to avoid API rate-limit surprises.
  tag="20241016"
  case "$arch" in
    x86_64|amd64)
      url="https://github.com/astral-sh/python-build-standalone/releases/download/${tag}/cpython-3.12.7+${tag}-x86_64-unknown-linux-gnu-install_only.tar.gz"
      ;;
    aarch64|arm64)
      url="https://github.com/astral-sh/python-build-standalone/releases/download/${tag}/cpython-3.12.7+${tag}-aarch64-unknown-linux-gnu-install_only.tar.gz"
      ;;
    *)
      error "install_python312_standalone: unsupported arch $arch"
      exit 1
      ;;
  esac

  tmp=$(mktemp -d)
  log "Downloading portable Python 3.12 from python-build-standalone (${arch})..."
  curl -fsSL "$url" -o "$tmp/py312.tar.gz"
  $SUDO mkdir -p /opt
  $SUDO rm -rf /opt/python-3.12
  $SUDO tar -xzf "$tmp/py312.tar.gz" -C /opt
  $SUDO mv /opt/python /opt/python-3.12
  $SUDO ln -sf /opt/python-3.12/bin/python3.12 /usr/local/bin/python3.12
  rm -rf "$tmp"
  log "python3.12 installed at /opt/python-3.12 (symlinked to /usr/local/bin/python3.12)"
}

install_system_packages() {
  local mgr=$1
  # These are the non-python packages we always need, and will succeed on any
  # supported Debian/Ubuntu release.
  local base_pkgs=(git python3 python3-pip python3-venv python3-dev build-essential \
                   xvfb xdotool ffmpeg curl ca-certificates software-properties-common)
  # python3.12 is required as a fallback runtime because TensorFlow does not
  # ship wheels for Python 3.13+. On older Ubuntu (22.04/24.04) it's in main.
  # On very new Ubuntu (26.04 "resolute") it needs deadsnakes PPA, and if
  # deadsnakes doesn't publish for that codename we install a standalone
  # binary tarball via install_python312_standalone().
  local py312_pkgs=(python3.12 python3.12-venv python3.12-dev)
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
      # Step 1: install base packages (always available on Ubuntu/Debian).
      # Use `env` so the env-var-prefix syntax works regardless of whether
      # $SUDO expands to empty (root) or to `sudo` (non-root).
      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${base_pkgs[@]}"

      # Step 2: try to get python3.12.
      #   - If it's in main repos already (Ubuntu 24.04), install directly.
      #   - Otherwise add deadsnakes PPA and retry.
      #   - If both fail (e.g. deadsnakes hasn't published for this codename),
      #     fall back to a standalone portable binary via helper.
      if $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${py312_pkgs[@]}" 2>/tmp/py312-main.err; then
        log "python3.12 installed from main repos"
      else
        warn "python3.12 not in main repos; adding Deadsnakes PPA..."
        if $SUDO add-apt-repository -y ppa:deadsnakes/ppa 2>/tmp/deadsnakes-add.err \
           && $SUDO apt-get update -qq 2>/tmp/apt-update2.err \
           && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${py312_pkgs[@]}" 2>/tmp/py312-ppa.err; then
          log "python3.12 installed from Deadsnakes PPA"
        else
          warn "Deadsnakes PPA did not provide python3.12 for this Ubuntu codename."
          warn "Falling back to python-build-standalone portable binary..."
          install_python312_standalone
        fi
      fi
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
  # Check both commands (git/xvfb/etc) AND critical apt packages that don't
  # install their own /usr/bin binary (build-essential, python3-dev,
  # python3.12) that we discover only via dpkg.
  local need=0
  for cmd in git python3 Xvfb xdotool ffmpeg curl gcc; do
    if ! have "$cmd"; then need=1; break; fi
  done
  if [ "$need" -eq 0 ] && [ "$mgr" = "apt" ]; then
    # gcc is present but check python3.12 too (needed for TF compatibility).
    if ! have python3.12; then need=1; fi
    # And python3-dev headers so pip source builds succeed.
    if ! dpkg -s python3-dev >/dev/null 2>&1; then need=1; fi
  fi
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
  # TensorFlow does not yet ship wheels for Python 3.13+. If the system's
  # default python3 is too new, prefer python3.12 (installed above via apt)
  # for the venv so tensorflow-cpu is installable from a pre-built wheel.
  local VENV="$INSTALL_DIR/.venv"
  local venv_py="$PYTHON_BIN"
  local sys_py_ver
  sys_py_ver=$($PYTHON_BIN -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  if [ "$(printf '%s\n' "$sys_py_ver" 3.13 | sort -V | head -n1)" = "3.13" ] && [ "$sys_py_ver" != "3.12" ]; then
    if have python3.12; then
      log "System Python is $sys_py_ver (too new for TensorFlow); using python3.12 for venv"
      venv_py="python3.12"
    else
      warn "System Python is $sys_py_ver and python3.12 is not installed;"
      warn "tensorflow-cpu will likely fail. Consider installing python3.12 manually."
    fi
  fi

  # If existing venv uses a python we no longer want (e.g. old 3.14 attempt),
  # rebuild it with the chosen interpreter.
  if [ -x "$VENV/bin/python" ]; then
    local existing_ver
    existing_ver=$("$VENV/bin/python" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo unknown)
    local wanted_ver
    wanted_ver=$("$venv_py" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo unknown)
    if [ "$existing_ver" != "$wanted_ver" ]; then
      log "Recreating venv (was Python $existing_ver, want $wanted_ver)"
      rm -rf "$VENV"
    else
      log "Python venv already present (Python $existing_ver)"
    fi
  fi
  if [ ! -x "$VENV/bin/python" ]; then
    log "Creating Python venv at $VENV using $venv_py"
    # First try the normal path (with bundled pip via ensurepip).
    if ! "$venv_py" -m venv "$VENV" 2>/tmp/venv.err; then
      warn "venv with ensurepip failed:"
      warn "$(tail -n 3 /tmp/venv.err)"
      warn "Retrying with --without-pip and bootstrapping pip via get-pip.py"
      rm -rf "$VENV"
      "$venv_py" -m venv --without-pip "$VENV"
      # Bootstrap pip inside the venv.
      local getpip="/tmp/get-pip.py"
      curl -fsSL https://bootstrap.pypa.io/get-pip.py -o "$getpip"
      "$VENV/bin/python" "$getpip"
      rm -f "$getpip"
    fi
  fi
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  python -m pip install --quiet --upgrade pip

  # ---- 4. Python packages ----
  # We try progressively looser constraints so it works on both mature
  # (Ubuntu 22.04 / Python 3.11) and very fresh (Ubuntu 26.04 / Python 3.13)
  # systems. On very fresh Python where TF doesn't ship wheels yet, pip would
  # try to build numpy from source. build-essential (installed above) covers
  # that case, but it's slow, so we first try binary-only.
  log "Installing Python packages (may take several minutes)..."
  local py_ver
  py_ver=$(python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  log "Python: $py_ver"

  # Attempt 1: pinned TF, binary-only (fast path, works on 3.10-3.12).
  if pip install --quiet --only-binary=:all: \
        "scrapling[fetchers]" playwright pillow \
        "tensorflow-cpu==${TF_VERSION}" 2>/tmp/pip1.err; then
    log "Installed with pinned tensorflow-cpu==${TF_VERSION}"
  # Attempt 2: latest TF, binary-only (works when TF has a fresh wheel).
  elif pip install --quiet --only-binary=:all: \
        "scrapling[fetchers]" playwright pillow tensorflow-cpu 2>/tmp/pip2.err; then
    log "Installed with latest tensorflow-cpu (binary wheel)"
  # Attempt 3: latest TF, allow source builds (works on very new Python
  # where TF has no wheel yet; requires build-essential + python3-dev,
  # which we already installed above via apt).
  else
    warn "No binary wheels found; falling back to source build (slow)..."
    pip install "scrapling[fetchers]" playwright pillow tensorflow-cpu
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
