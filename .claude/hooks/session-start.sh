#!/bin/bash
#
# SessionStart hook for Claude Code on the web.
#
# Prepares an ephemeral container so the app's tests/linters run AND the
# `dev-team@bfinster` plugin is ready to use:
#   1. Installs npm dependencies.
#   2. Ensures the dev-team plugin (+ its bfinster marketplace) is installed.
#   3. Runs the plugin's init-dev-team setup (jq, python3, Stryker, CodeGraph).
#
# Idempotent and non-interactive. Web-only (no-op on local machines).
set -uo pipefail

# Only run inside Claude Code on the web; local machines manage their own setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$PROJECT_DIR" || exit 1

# --- 1. App dependencies ----------------------------------------------------
# Prefer `npm install` over `npm ci` so the cached container layer is reused.
echo "[session-start] Installing npm dependencies..."
npm install || echo "[session-start] npm install reported issues — continuing."

# --- 2. Ensure the dev-team plugin is installed -----------------------------
# The checked-in .claude/settings.json registers the bfinster marketplace and
# enables dev-team@bfinster, so the marketplace is normally auto-cached. Make
# the install explicit (best-effort) so the plugin's commands are available.
if command -v claude >/dev/null 2>&1; then
  echo "[session-start] Ensuring dev-team@bfinster plugin is installed..."
  claude plugin marketplace add bdfinst/agentic-dev-team >/dev/null 2>&1 || true
  claude plugin install dev-team@bfinster >/dev/null 2>&1 || true
fi

# --- 3. Run the plugin's init-dev-team setup --------------------------------
# Locate the Linux replica of the init-dev-team skill. Prefer the cached
# marketplace; fall back to a shallow clone if it isn't present yet.
MARKET_DIR="$HOME/.claude/plugins/marketplaces/bfinster"
INIT_SCRIPT="$MARKET_DIR/init-dev-team-linux.sh"
PLUGIN_ROOT="$MARKET_DIR/plugins/dev-team"

if [ ! -f "$INIT_SCRIPT" ]; then
  echo "[session-start] Marketplace cache missing — cloning agentic-dev-team..."
  TMP_CLONE="$(mktemp -d)"
  if git clone --depth 1 https://github.com/bdfinst/agentic-dev-team "$TMP_CLONE" >/dev/null 2>&1; then
    INIT_SCRIPT="$TMP_CLONE/init-dev-team-linux.sh"
    PLUGIN_ROOT="$TMP_CLONE/plugins/dev-team"
  fi
fi

if [ -f "$INIT_SCRIPT" ]; then
  echo "[session-start] Running dev-team init..."
  # SKIP_PROBE: the model-availability probe needs ANTHROPIC_API_KEY and is
  # non-essential; skip it to keep startup output clean. Drop this to enable it.
  PLUGIN_ROOT="$PLUGIN_ROOT" SKIP_PROBE=1 bash "$INIT_SCRIPT" \
    || echo "[session-start] dev-team init reported issues — continuing."
else
  echo "[session-start] Could not locate init-dev-team script — skipping plugin setup."
fi

echo "[session-start] Setup complete."
