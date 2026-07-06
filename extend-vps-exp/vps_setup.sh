#!/usr/bin/env bash
# vps_setup.sh — self-installing runner for Xserver VPS auto-renew (CloakBrowser edition).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/gamelist1990/Debug/main/extend-vps-exp/vps_setup.sh | bash
#   # or after clone:
#   bash extend-vps-exp/vps_setup.sh            # install + run
#   bash extend-vps-exp/vps_setup.sh --install  # install only
#   bash extend-vps-exp/vps_setup.sh --run      # run only (installs if needed)
#   bash extend-vps-exp/vps_setup.sh --cron     # register daily cron job
#
# Supports Debian/Ubuntu on x86_64 and aarch64. Idempotent — re-runnable safely.
#
# What this installs:
#   1. System deps: git, python3.12, Xvfb, ffmpeg, Chromium runtime libs, Linux fonts
#   2. Python venv with: cloakbrowser, tensorflow-cpu, pillow
#   3. CloakBrowser stealth Chromium binary (auto-downloaded on first launch)
#
# CloakBrowser is a Playwright-compatible wrapper around a Chromium binary
# with 66 C++ source-level fingerprint patches. It passes Cloudflare Turnstile
# natively — no captcha-solving extension, no proxy required (though a
# residential proxy improves reliability).

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/gamelist1990/Debug.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/xserver-auto-renew}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
TF_VERSION="${TF_VERSION:-2.19.0}"
CRON_TIME="${CRON_TIME:-0 3 * * *}"

SCRIPT_ABS_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"

# ------------------------------------------------------------------
# Utilities
# ------------------------------------------------------------------
c_reset=$'\033[0m'; c_bold=$'\033[1m'
c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'
log()   { printf "%s==>%s %s\n" "${c_bold}${c_green}" "${c_reset}" "$*"; }
warn()  { printf "%s==>%s %s\n" "${c_bold}${c_yellow}" "${c_reset}" "$*" >&2; }
error() { printf "%s==>%s %s\n" "${c_bold}${c_red}"    "${c_reset}" "$*" >&2; }
have()  { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif have sudo; then
  SUDO="sudo"
else
  error "Neither root nor sudo available. Re-run as root or install sudo."
  exit 1
fi

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo x86_64 ;;
    aarch64|arm64) echo aarch64 ;;
    *) error "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
}

detect_pkg_mgr() {
  have apt-get && { echo apt; return; }
  have dnf     && { echo dnf; return; }
  have yum     && { echo yum; return; }
  have apk     && { echo apk; return; }
  have pacman  && { echo pacman; return; }
  echo unknown
}

# Fallback: install python3.12 via `uv` when apt/deadsnakes has no wheel for
# this Ubuntu codename (e.g. brand-new 26.04). Handles relocation properly.
install_python312_via_uv() {
  local uv_bin="$HOME/.local/bin/uv"
  if [ ! -x "$uv_bin" ] && ! have uv; then
    log "Installing uv (Python version manager) from astral.sh"
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
  export PATH="$HOME/.local/bin:$PATH"
  have uv || { error "uv install failed"; exit 1; }
  log "Installing Python 3.12 via uv"
  uv python install 3.12
  local py312
  py312=$(uv python find 3.12 2>/dev/null || true)
  [ -x "$py312" ] || { error "uv reported success but 3.12 exec missing"; exit 1; }
  $SUDO ln -sf "$py312" /usr/local/bin/python3.12
  log "python3.12 installed at: $py312"
}

# ------------------------------------------------------------------
# Fonts (always run on every install — separate from the guarded system
# package block below, so re-installing after adding new font names
# actually pulls them in).
# ------------------------------------------------------------------
install_fonts_apt() {
  # Japanese CJK: fonts-noto-cjk is the most comprehensive (hiragana,
  # katakana, kanji, punctuation, CJK symbols). Without it, Xserver's
  # Japanese UI renders as tofu (□) in the screenshot artifacts.
  # ttf-mscorefonts-installer + fonts-liberation give real Windows fonts
  # (Arial/Times/Verdana), fixing CloakBrowser's "Win fonts: missing" and
  # improving Windows-spoof canvas metrics against FingerprintJS/CF.
  local fonts=(
    # Latin + emoji + fallback
    fonts-noto-color-emoji fonts-freefont-ttf fonts-unifont fonts-liberation
    # Japanese (CJK) — critical for Xserver UI rendering
    fonts-noto-cjk fonts-noto-cjk-extra
    fonts-ipafont-gothic fonts-ipafont-mincho
    fonts-takao-gothic fonts-takao-mincho
    # Chinese/Korean fallback (some CJK glyphs Japanese fonts miss)
    fonts-wqy-zenhei fonts-nanum
    # Windows fonts for CloakBrowser Windows-spoof
    ttf-mscorefonts-installer
  )

  log "ensuring CJK + Windows fonts are installed"
  # Pre-accept EULA for msttcorefonts (silent installer requirement).
  echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" \
    | $SUDO debconf-set-selections 2>/dev/null || true

  # Install one-by-one so a single missing package name (e.g. on a codename
  # where fonts-noto-cjk-extra doesn't exist) doesn't abort the whole set.
  local installed=0 missing=0
  for pkg in "${fonts[@]}"; do
    if dpkg -s "$pkg" >/dev/null 2>&1; then
      installed=$((installed + 1))
      continue
    fi
    if $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$pkg" \
         >/dev/null 2>/tmp/font-$pkg.err; then
      log "  + $pkg"
      installed=$((installed + 1))
    else
      warn "  ! $pkg not installable on this codename (skipping)"
      missing=$((missing + 1))
    fi
  done
  log "fonts: $installed installed, $missing missing"

  # Refresh font cache so Chromium picks up newly-installed fonts.
  if have fc-cache; then
    log "refreshing font cache (fc-cache -f)"
    fc-cache -f >/dev/null 2>&1 || true
  fi

  # Diagnostic: confirm at least one Japanese font is actually visible to
  # fontconfig. If not, screenshots will still tofu even after apt succeeded.
  if have fc-list; then
    local ja_count
    ja_count=$(fc-list :lang=ja 2>/dev/null | wc -l)
    if [ "$ja_count" -gt 0 ]; then
      log "Japanese fonts detected by fontconfig: $ja_count entries"
    else
      warn "fontconfig sees 0 Japanese fonts — screenshots will tofu"
      warn "try manually: sudo apt-get install fonts-noto-cjk && fc-cache -f"
    fi
  fi
}

install_system_packages() {
  local mgr=$1

  # Base build/network deps.
  local base=(git python3 python3-pip python3-venv python3-dev build-essential
              xvfb xdotool ffmpeg curl ca-certificates software-properties-common)

  # Chromium runtime libraries — CloakBrowser bundles the binary but not the
  # system .so files. Names cover both Ubuntu 22.04 (pre-t64) and 24.04+ (t64).
  local chromium_libs=(
    libnss3 libnspr4 libxkbcommon0 libxcomposite1 libxdamage1
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2
    libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libatspi2.0-0t64
    libasound2 libatk1.0-0 libatk-bridge2.0-0 libcups2 libatspi2.0-0
  )

  # TensorFlow has no wheels for Python 3.13+, so we pin to 3.12.
  local py312=(python3.12 python3.12-venv python3.12-dev)

  case "$mgr" in
    apt)
      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq 2>/tmp/apt-update.err || \
        warn "apt-get update had errors (broken third-party repo?); continuing"

      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${base[@]}"

      # Chromium libs — install individually, tolerate misses (t64 vs pre-t64).
      for lib in "${chromium_libs[@]}"; do
        $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$lib" \
          >/dev/null 2>&1 || true
      done

      # python3.12: try main repo → deadsnakes PPA → uv fallback.
      if $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${py312[@]}" 2>/dev/null; then
        log "python3.12 installed from main repos"
      elif $SUDO add-apt-repository -y ppa:deadsnakes/ppa 2>/dev/null \
        && $SUDO apt-get update -qq 2>/dev/null \
        && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${py312[@]}" 2>/dev/null; then
        log "python3.12 installed from Deadsnakes PPA"
      else
        warn "python3.12 apt install failed, using uv fallback"
        install_python312_via_uv
      fi
      ;;
    dnf|yum)
      $SUDO "$mgr" install -y git python3 python3-pip xorg-x11-server-Xvfb xdotool ffmpeg curl ca-certificates
      ;;
    apk)
      $SUDO apk add --no-cache git python3 py3-pip py3-virtualenv xvfb xdotool ffmpeg curl ca-certificates
      ;;
    pacman)
      $SUDO pacman -Sy --noconfirm --needed git python python-pip xorg-server-xvfb xdotool ffmpeg curl ca-certificates
      ;;
    *)
      error "Unsupported package manager"; exit 1 ;;
  esac
}

# ------------------------------------------------------------------
# Install
# ------------------------------------------------------------------
do_install() {
  local arch mgr
  arch=$(detect_arch)
  mgr=$(detect_pkg_mgr)
  log "arch=$arch pkg-mgr=$mgr install-dir=$INSTALL_DIR"

  # Clean up broken standalone python3.12 from earlier NopeCHA-era runs.
  if [ -L /usr/local/bin/python3.12 ]; then
    local tgt
    tgt=$(readlink /usr/local/bin/python3.12 || true)
    case "$tgt" in
      /opt/python-3.12/*)
        log "removing broken standalone python3.12 from previous run"
        $SUDO rm -f /usr/local/bin/python3.12
        $SUDO rm -rf /opt/python-3.12
        ;;
    esac
  fi

  # ---- System packages ----
  local need=0
  for cmd in git python3 Xvfb xdotool ffmpeg curl gcc; do
    have "$cmd" || { need=1; break; }
  done
  if [ "$need" -eq 0 ] && [ "$mgr" = "apt" ]; then
    { have python3.12 && python3.12 -c 'import sys' >/dev/null 2>&1; } || need=1
    dpkg -s python3-dev >/dev/null 2>&1 || need=1
  fi
  if [ "$need" -eq 1 ]; then
    log "installing system packages"
    install_system_packages "$mgr"
  else
    log "system packages already present"
  fi

  # ---- Fonts (always run — new packages get picked up on re-install) ----
  if [ "$mgr" = "apt" ]; then
    install_fonts_apt
  fi

  # ---- Repo checkout ----
  if [ ! -d "$INSTALL_DIR/.git" ]; then
    log "cloning $REPO_URL into $INSTALL_DIR"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  else
    log "updating repo at $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --depth 1 origin main
    git -C "$INSTALL_DIR" reset --hard origin/main
  fi

  local APP_DIR="$INSTALL_DIR/extend-vps-exp"
  cd "$APP_DIR"

  # ---- Python venv (prefer 3.12; TF has no wheels for 3.13+) ----
  local VENV="$INSTALL_DIR/.venv"
  local venv_py="$PYTHON_BIN"
  local sys_ver
  sys_ver=$($PYTHON_BIN -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  if [ "$(printf '%s\n' "$sys_ver" 3.13 | sort -V | head -n1)" = "3.13" ] && [ "$sys_ver" != "3.12" ]; then
    if have python3.12; then
      log "system python is $sys_ver (too new for TF); venv will use python3.12"
      venv_py="python3.12"
    else
      warn "system python is $sys_ver and python3.12 is missing; TF install will likely fail"
    fi
  fi

  if [ -x "$VENV/bin/python" ]; then
    local existing wanted
    existing=$("$VENV/bin/python" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo unknown)
    wanted=$("$venv_py" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo unknown)
    if [ "$existing" != "$wanted" ]; then
      log "recreating venv (was $existing, want $wanted)"
      rm -rf "$VENV"
    fi
  fi
  if [ ! -x "$VENV/bin/python" ]; then
    log "creating venv at $VENV using $venv_py"
    if ! "$venv_py" -m venv "$VENV" 2>/tmp/venv.err; then
      warn "venv+ensurepip failed, retrying with --without-pip + get-pip.py"
      rm -rf "$VENV"
      "$venv_py" -m venv --without-pip "$VENV"
      curl -fsSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py
      "$VENV/bin/python" /tmp/get-pip.py
      rm -f /tmp/get-pip.py
    fi
  fi
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"
  python -m pip install --quiet --upgrade pip

  # ---- Python packages ----
  log "installing Python packages (may take several minutes)"
  local py_ver
  py_ver=$(python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  log "venv python=$py_ver"

  # Attempt 1: pinned TF, binary-only wheels (fastest, works 3.10–3.12).
  if pip install --quiet --only-binary=:all: \
      cloakbrowser "cloakbrowser[geoip]" pillow "tensorflow-cpu==${TF_VERSION}" 2>/tmp/pip1.err; then
    log "installed with pinned tensorflow-cpu==${TF_VERSION}"
  # Attempt 2: latest TF wheels.
  elif pip install --quiet --only-binary=:all: \
      cloakbrowser "cloakbrowser[geoip]" pillow tensorflow-cpu 2>/tmp/pip2.err; then
    log "installed with latest tensorflow-cpu (binary wheel)"
  # Attempt 3: fall back to source build (slow, needs build-essential).
  else
    warn "no binary TF wheel found; falling back to source build (slow)"
    pip install cloakbrowser "cloakbrowser[geoip]" pillow tensorflow-cpu
  fi

  # ---- CloakBrowser Chromium binary ----
  # Auto-downloads on first launch, but pre-downloading here avoids stalling
  # the first cron run behind a 200MB HTTP fetch.
  log "pre-downloading CloakBrowser Chromium binary (~200MB)"
  python -m cloakbrowser install || warn "pre-download failed; will retry on first launch"

  # Quick diagnostics (non-fatal). --quick skips the launch test.
  log "CloakBrowser diagnostics:"
  python -m cloakbrowser info --quick 2>/dev/null | head -n 15 || true

  # ---- .env template ----
  if [ ! -f "$APP_DIR/.env" ]; then
    cat > "$APP_DIR/.env" <<'EOF'
# Xserver login credentials (required)
EMAIL=your-email@example.com
PASSWORD=your-password

# Optional: CloakBrowser Pro license (unlocks the latest Chromium 148 binary
# with 66 stealth patches). The free v146 binary works without one.
# CLOAKBROWSER_LICENSE_KEY=cb_xxxxxxxxxxxxxxxx

# Optional: HTTP/HTTPS/SOCKS5 proxy (residential IP recommended for anti-bot).
# PROXY_SERVER=socks5://user:pass@host:port
EOF
    chmod 600 "$APP_DIR/.env"
    warn ".env template created at $APP_DIR/.env — edit before first run"
  else
    log ".env already exists"
  fi

  log "install complete"
  echo "    1. Edit  $APP_DIR/.env"
  echo "    2. Test: bash $SCRIPT_ABS_PATH --run"
  echo "    3. Cron: bash $SCRIPT_ABS_PATH --cron"
}

# ------------------------------------------------------------------
# Run
# ------------------------------------------------------------------
do_run() {
  local APP_DIR="$INSTALL_DIR/extend-vps-exp"
  local VENV="$INSTALL_DIR/.venv"

  if [ ! -x "$VENV/bin/python" ] || [ ! -d "$APP_DIR" ]; then
    warn "not installed; running install first"
    do_install
  fi

  cd "$APP_DIR"
  # shellcheck disable=SC1091
  source "$VENV/bin/activate"

  # ---- Xvfb ----
  # CloakBrowser's C++ stealth patches work in both headed and headless mode,
  # but Cloudflare-protected sites empirically pass more reliably in headed
  # mode. Xvfb :99 provides the virtual display on headless VPS/cron.
  if ! pgrep -f "Xvfb :99" >/dev/null 2>&1; then
    log "starting Xvfb on :99"
    Xvfb :99 -screen 0 1280x900x24 -ac >/tmp/xvfb.log 2>&1 &
    sleep 1
  fi
  export DISPLAY=:99

  # ---- Runtime env ----
  export HEADLESS=0                    # headed via Xvfb
  export DEBUG_VIDEO="${DEBUG_VIDEO:-0}"
  export TF_CPP_MIN_LOG_LEVEL=2        # silence TF chatter

  # CAPTCHA model at repo root.
  if [ -f "$INSTALL_DIR/xserver_captcha.keras" ]; then
    export CAPTCHA_MODEL_PATH="$INSTALL_DIR/xserver_captcha.keras"
  fi

  # ---- Load .env (cron has a minimal environment) ----
  if [ -f "$APP_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$APP_DIR/.env"
    set +a
  fi

  log "$(date -Is) starting main.py"
  python main.py
  local rc=$?
  log "$(date -Is) main.py exited rc=$rc"
  return $rc
}

# ------------------------------------------------------------------
# Cron helper
# ------------------------------------------------------------------
do_cron() {
  local marker="# xserver-auto-renew (managed by vps_setup.sh)"
  local line="${CRON_TIME} bash ${SCRIPT_ABS_PATH} --run >> ${INSTALL_DIR}/cron.log 2>&1  ${marker}"

  local current
  current=$(crontab -l 2>/dev/null || true)
  if echo "$current" | grep -Fq "$marker"; then
    log "updating existing cron entry"
    printf '%s\n' "$current" | grep -vF "$marker" > /tmp/.crontab.new
  else
    log "adding new cron entry"
    printf '%s\n' "$current" > /tmp/.crontab.new
  fi
  printf '%s\n' "$line" >> /tmp/.crontab.new
  crontab /tmp/.crontab.new
  rm -f /tmp/.crontab.new

  log "cron entry installed:"
  echo "    $line"
  log "logs: tail -f ${INSTALL_DIR}/cron.log"
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
  --cron      Register a daily cron job (see CRON_TIME env var).
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
