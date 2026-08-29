#!/usr/bin/env bash
# Open AMC installer (Linux/macOS). Installs the pinned Open AMC release into a
# user-owned directory, exposes the `amc` CLI, and installs the agent skill via
# the detected platform's native mechanism (Hermes and/or OpenClaw).
#
#   bash install.sh [--agent auto|hermes|openclaw|none]
#
# Environment overrides (production defaults pin the release; never mutable main):
#   OPEN_AMC_REPOSITORY  Git URL           (default https://github.com/ashah360/open-amc.git)
#   OPEN_AMC_REF         tag or branch     (default v0.1.2)
#   OPEN_AMC_HOME        install checkout  (default $HOME/.open-amc/app)
#   BIN_DIR              CLI symlink dir   (default $HOME/.local/bin)
#   OPEN_AMC_SKILL_URL   Hermes SKILL URL  (default raw GitHub SKILL.md at OPEN_AMC_REF)
#
# No sudo, no secrets, no telemetry. Requires: bash, git, npm (Node >= 22).
set -euo pipefail

OPEN_AMC_REPOSITORY="${OPEN_AMC_REPOSITORY:-https://github.com/ashah360/open-amc.git}"
OPEN_AMC_REF="${OPEN_AMC_REF:-v0.1.2}"
OPEN_AMC_HOME="${OPEN_AMC_HOME:-$HOME/.open-amc/app}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
OPEN_AMC_SKILL_URL="${OPEN_AMC_SKILL_URL:-https://raw.githubusercontent.com/ashah360/open-amc/${OPEN_AMC_REF}/SKILL.md}"

AGENT="auto"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent)
      [ "$#" -ge 2 ] || { echo "error: --agent requires a value" >&2; exit 2; }
      AGENT="$2"
      shift 2
      ;;
    --agent=*)
      AGENT="${1#--agent=}"
      shift
      ;;
    -h | --help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      exit 2
      ;;
  esac
done
case "$AGENT" in
  auto | hermes | openclaw | none) ;;
  *)
    echo "error: --agent must be auto|hermes|openclaw|none" >&2
    exit 2
    ;;
esac

log() { printf '%s\n' "$*"; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: required command not found: $1" >&2
    exit 1
  }
}
require_command git
require_command npm

is_open_amc_checkout() {
  [ -f "$1/package.json" ] && grep -q '"@ashah360/open-amc"' "$1/package.json"
}

# --- Acquire or update the pinned checkout (never rm -rf, never a foreign dir).
if [ -d "$OPEN_AMC_HOME/.git" ]; then
  if ! is_open_amc_checkout "$OPEN_AMC_HOME"; then
    echo "error: refusing to touch $OPEN_AMC_HOME: it is a git checkout but not @ashah360/open-amc" >&2
    exit 1
  fi
  log "Updating existing checkout at $OPEN_AMC_HOME to $OPEN_AMC_REF"
  # Check out the exact FETCHED ref: a stale local branch of the same name
  # (from the original clone) must never win over the freshly fetched one.
  git -C "$OPEN_AMC_HOME" fetch --force --tags origin "$OPEN_AMC_REF"
  git -C "$OPEN_AMC_HOME" checkout --force --detach FETCH_HEAD
elif [ -e "$OPEN_AMC_HOME" ] && [ -n "$(ls -A "$OPEN_AMC_HOME" 2>/dev/null)" ]; then
  echo "error: refusing to install into nonempty non-open-amc directory: $OPEN_AMC_HOME" >&2
  exit 1
else
  log "Cloning $OPEN_AMC_REPOSITORY at $OPEN_AMC_REF into $OPEN_AMC_HOME"
  mkdir -p "$(dirname "$OPEN_AMC_HOME")"
  git clone --branch "$OPEN_AMC_REF" --depth 1 "$OPEN_AMC_REPOSITORY" "$OPEN_AMC_HOME"
fi

log "Installing dependencies (builds the CLI via npm prepare)"
(cd "$OPEN_AMC_HOME" && npm install --no-audit --no-fund)

# --- Expose the CLI.
mkdir -p "$BIN_DIR"
ln -sf "$OPEN_AMC_HOME/bin/amc" "$BIN_DIR/amc"

# --- Verify readiness before claiming success.
log "Verifying: amc doctor --json"
"$BIN_DIR/amc" doctor --json >/dev/null

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    log "WARNING: $BIN_DIR is not on your PATH. Add it, e.g.:"
    log "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

# --- Agent skill installation via each platform's NATIVE mechanism.
install_hermes_skill() {
  log "Installing Hermes skill from $OPEN_AMC_SKILL_URL"
  hermes skills install "$OPEN_AMC_SKILL_URL" --now
}
install_openclaw_skill() {
  log "Installing OpenClaw skill from $OPEN_AMC_HOME"
  openclaw skills install "$OPEN_AMC_HOME" --global --as open-amc
}
print_later_commands() {
  log "No agent platform detected. The CLI is installed; to add the skill later:"
  log "  hermes skills install $OPEN_AMC_SKILL_URL --now"
  log "  openclaw skills install $OPEN_AMC_HOME --global --as open-amc"
}

case "$AGENT" in
  hermes)
    require_command hermes
    install_hermes_skill
    ;;
  openclaw)
    require_command openclaw
    install_openclaw_skill
    ;;
  none) ;;
  auto)
    detected=0
    if command -v hermes >/dev/null 2>&1; then
      install_hermes_skill
      detected=1
    fi
    if command -v openclaw >/dev/null 2>&1; then
      install_openclaw_skill
      detected=1
    fi
    if [ "$detected" -eq 0 ]; then
      print_later_commands
    fi
    ;;
esac

log "Open AMC $OPEN_AMC_REF installed. Next:"
log "  amc setup --theater-url \"<official AMC theater URL>\" --json"
