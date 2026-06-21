#!/bin/bash
#
# install-web-hook.sh — Install the web-only SessionStart hook into a project.
#
# Drops a Claude Code on the web SessionStart hook that, on each fresh
# ephemeral container, installs the dev-team@bfinster plugin and runs its
# init-dev-team setup. Also registers the hook (and the plugin/marketplace)
# in the target project's .claude/settings.json.
#
# This is a self-contained, portable installer: copy this one file into any
# repo and run it. It is idempotent — safe to re-run.
#
# Usage:
#   ./install-web-hook.sh [TARGET_DIR]      # default: current directory
#
# Requirements: bash, jq.
set -euo pipefail

TARGET_DIR="${1:-$PWD}"
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
CLAUDE_DIR="$TARGET_DIR/.claude"
HOOKS_DIR="$CLAUDE_DIR/hooks"
HOOK_FILE="$HOOKS_DIR/session-start.sh"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required (install from https://jqlang.github.io/jq/)." >&2
  exit 1
fi

echo "Installing web-only SessionStart hook into: $TARGET_DIR"
mkdir -p "$HOOKS_DIR"

# --- 1. Write the hook script ----------------------------------------------
cat > "$HOOK_FILE" << 'HOOK'
#!/bin/bash
#
# SessionStart hook for Claude Code on the web.
#
# Prepares an ephemeral container so the app's tests/linters run AND the
# `dev-team@bfinster` plugin is ready to use:
#   1. Installs npm dependencies (if a package.json is present).
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
if [ -f package.json ]; then
  echo "[session-start] Installing npm dependencies..."
  npm install || echo "[session-start] npm install reported issues — continuing."
fi

# --- 2. Ensure the dev-team plugin is installed -----------------------------
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
HOOK
chmod +x "$HOOK_FILE"
echo "  ✓ wrote $HOOK_FILE"

# --- 2. Register the SessionStart hook (idempotent) ------------------------
[ -f "$SETTINGS_FILE" ] || echo '{}' > "$SETTINGS_FILE"

TMP_SETTINGS="$(mktemp)"
jq '
  # Register the SessionStart hook only if not already present.
  .hooks.SessionStart = ((.hooks.SessionStart // [])
    | if any(.[]?; (.hooks // []) | any(.command == "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"))
      then .
      else . + [{"hooks": [{"type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"}]}]
      end)
' "$SETTINGS_FILE" > "$TMP_SETTINGS"
mv "$TMP_SETTINGS" "$SETTINGS_FILE"
echo "  ✓ registered SessionStart hook in $SETTINGS_FILE"

# --- 3. Register the plugin + marketplace at project scope -----------------
# Prefer the `claude` CLI with --scope=project so the marketplace add / plugin
# install are written into THIS project's .claude/settings.json. Fall back to
# editing settings.json directly when the CLI isn't available.
if command -v claude >/dev/null 2>&1; then
  # Best-effort and idempotent: these are no-ops when already registered. The
  # `|| true` guards keep a non-zero exit (e.g. "already installed" on some CLI
  # versions) from aborting the script under `set -e` and skipping autoUpdate.
  ( cd "$TARGET_DIR" || exit 1
    claude plugin marketplace add bdfinst/agentic-dev-team --scope=project || true
    claude plugin install dev-team@bfinster --scope=project || true )
  echo "  ✓ added marketplace + installed dev-team@bfinster (project scope)"
else
  echo "  ! claude CLI not found — registering plugin/marketplace via jq instead."
  TMP_SETTINGS="$(mktemp)"
  jq '
    .enabledPlugins["dev-team@bfinster"] = true
    | .extraKnownMarketplaces.bfinster = {
        "source": {"source": "github", "repo": "bdfinst/agentic-dev-team"}
      }
  ' "$SETTINGS_FILE" > "$TMP_SETTINGS"
  mv "$TMP_SETTINGS" "$SETTINGS_FILE"
fi

# Enable auto-update for the marketplace (third-party marketplaces default to off).
TMP_SETTINGS="$(mktemp)"
jq '.extraKnownMarketplaces.bfinster.autoUpdate = true' "$SETTINGS_FILE" > "$TMP_SETTINGS"
mv "$TMP_SETTINGS" "$SETTINGS_FILE"
echo "  ✓ enabled marketplace auto-update"

echo ""
echo "Done. Commit .claude/ to your default branch so future web sessions use it."
