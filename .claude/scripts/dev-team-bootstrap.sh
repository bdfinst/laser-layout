#!/bin/bash
#
# Shared bootstrap for Claude Code cloud sessions.
#
# Prepares an ephemeral container so the app's tests/linters run AND the
# `dev-team@bfinster` plugin is ready to use:
#   1. Installs npm dependencies.
#   2. Ensures the bfinster marketplace + dev-team plugin are installed ON DISK.
#   3. Runs the plugin's init-dev-team setup (jq, python3, Stryker, CodeGraph).
#
# This is the single source of truth, called from two places:
#   * .claude/cloud-setup.sh   -> the environment Setup script (runs BEFORE
#                                 Claude launches; result is snapshotted). This
#                                 is what actually makes the plugin LOAD, because
#                                 the files are on disk before plugin enumeration.
#   * .claude/hooks/session-start.sh -> SessionStart hook (runs AFTER Claude
#                                 launches). A fallback that warms the cache for
#                                 the NEXT session; it cannot load the plugin
#                                 into the current one.
#
# Idempotent and non-interactive. Safe to run repeatedly.
set -uo pipefail

# Resolve the repo root from this script's own location (.claude/scripts/..).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
cd "$PROJECT_DIR" || exit 1

MARKETPLACE_REPO="bdfinst/agentic-dev-team"
PLUGIN="dev-team@bfinster"

# --- 1. App dependencies ----------------------------------------------------
# Prefer `npm install` over `npm ci` so the cached container layer is reused.
echo "[bootstrap] Installing npm dependencies..."
npm install || echo "[bootstrap] npm install reported issues — continuing."

# --- 2. Ensure the dev-team plugin is installed -----------------------------
# The checked-in .claude/settings.json registers the bfinster marketplace and
# enables dev-team@bfinster. We make the install explicit (best-effort) so the
# plugin's skills/agents are on disk before Claude enumerates plugins at boot.
if command -v claude >/dev/null 2>&1; then
  echo "[bootstrap] Ensuring $PLUGIN plugin is installed..."
  claude plugin marketplace add "$MARKETPLACE_REPO" >/dev/null 2>&1 || true
  claude plugin install "$PLUGIN" >/dev/null 2>&1 || true
fi

# --- 3. Run the plugin's init-dev-team setup --------------------------------
# Locate the Linux replica of the init-dev-team skill. Prefer the cached
# marketplace; fall back to a shallow clone if it isn't present yet.
MARKET_DIR="$HOME/.claude/plugins/marketplaces/bfinster"
INIT_SCRIPT="$MARKET_DIR/init-dev-team-linux.sh"
PLUGIN_ROOT="$MARKET_DIR/plugins/dev-team"

if [ ! -f "$INIT_SCRIPT" ]; then
  echo "[bootstrap] Marketplace cache missing — cloning agentic-dev-team..."
  TMP_CLONE="$(mktemp -d)"
  if git clone --depth 1 "https://github.com/$MARKETPLACE_REPO" "$TMP_CLONE" >/dev/null 2>&1; then
    INIT_SCRIPT="$TMP_CLONE/init-dev-team-linux.sh"
    PLUGIN_ROOT="$TMP_CLONE/plugins/dev-team"
  fi
fi

if [ -f "$INIT_SCRIPT" ]; then
  echo "[bootstrap] Running dev-team init..."
  # SKIP_PROBE: the model-availability probe needs ANTHROPIC_API_KEY and is
  # non-essential; skip it to keep startup output clean. Drop this to enable it.
  PLUGIN_ROOT="$PLUGIN_ROOT" SKIP_PROBE=1 bash "$INIT_SCRIPT" \
    || echo "[bootstrap] dev-team init reported issues — continuing."
else
  echo "[bootstrap] Could not locate init-dev-team script — skipping plugin setup."
fi

echo "[bootstrap] Complete."
