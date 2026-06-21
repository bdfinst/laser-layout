#!/bin/bash
#
# SessionStart hook for Claude Code on the web.
#
# IMPORTANT: this hook runs AFTER Claude Code launches, so it CANNOT make a
# freshly-installed plugin load into the current session — plugin enumeration
# already happened at boot. The durable mechanism is the environment Setup
# script (.claude/cloud-setup.sh), which runs BEFORE boot and is snapshotted.
#
# This hook stays as a FALLBACK for environments where the Setup script has not
# been configured yet: it warms the on-disk cache so the plugin loads on the
# NEXT session, and it keeps npm deps current on resumed sessions. It delegates
# to the same shared bootstrap so there is a single source of truth.
#
# Web-only (no-op on local machines).
set -uo pipefail

# Only run inside Claude Code on the web; local machines manage their own setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
exec bash "$PROJECT_DIR/.claude/scripts/dev-team-bootstrap.sh"
