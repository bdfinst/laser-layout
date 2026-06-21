#!/bin/bash
#
# Claude Code on the web — environment Setup script ("the custom image").
# ----------------------------------------------------------------------------
# Claude Code on the web does NOT support replacing the base Docker image. The
# supported equivalent is a *setup script*: it runs as root BEFORE Claude Code
# launches, and Anthropic snapshots the resulting filesystem and reuses it as
# the starting point for later sessions. That snapshot is the de-facto custom
# image — anything this script writes to disk is baked in.
#
# Why this matters for plugins: Claude enumerates plugin skills/agents/commands
# at boot. A SessionStart hook runs AFTER boot, so a plugin it installs only
# loads on the NEXT session. A setup script runs BEFORE boot, so the plugin is
# already on disk when enumeration happens and loads in the SAME session.
#
# HOW TO INSTALL (one-time, per environment):
#   1. Open the environment settings dialog at claude.ai/code.
#   2. Paste the contents of THIS file into the "Setup script" field.
#   3. Ensure Network access is "Trusted" (or add github.com) so the marketplace
#      source can be reached.
#   4. Save. The next NEW session rebuilds the snapshot with the plugin baked in.
#
# Keeping the real logic in .claude/scripts/dev-team-bootstrap.sh (version
# controlled) means you only paste this thin stub once; logic changes ship via
# the repo without re-pasting.
set -uo pipefail

# The repo is already cloned when the setup script runs. Find its root robustly.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

exec bash "$REPO_ROOT/.claude/scripts/dev-team-bootstrap.sh"
