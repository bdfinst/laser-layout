# Baking Claude Code plugins into a cloud environment

A reusable pattern for making a marketplace plugin (skills, agents, commands,
hooks) reliably available in **Claude Code on the web** sessions — and how to
apply it to any repository.

## The problem

Declaring a plugin in your repo's `.claude/settings.json` is necessary but, on
its own, **not sufficient** for the plugin to load:

```jsonc
// .claude/settings.json
{
  "extraKnownMarketplaces": {
    "bfinster": { "source": { "source": "github", "repo": "bdfinst/agentic-dev-team" } },
  },
  "enabledPlugins": { "dev-team@bfinster": true },
}
```

Claude Code **enumerates plugin skills/agents/commands once, at process boot.**
In a fresh ephemeral cloud container the plugin cache is empty at that moment, so
nothing is enumerated. If the plugin is installed by a **`SessionStart` hook**,
that hook runs _after_ Claude has already launched — too late. The install
succeeds, the files land on disk, but they only load on the **next** session.

Symptom: `/<plugin-command>` returns "Unknown command", and the plugin's skills
and agents are absent from the session, even though `claude plugin list` shows
the plugin installed and enabled.

### Empirical evidence

Controlled runs in this environment (a fresh headless `claude -p` probe asked to
list its loaded skills), varying only _when the plugin files reach disk_:

| Scenario                                        | Files on disk **before** boot? | dev-team skills loaded |
| ----------------------------------------------- | :----------------------------: | :--------------------: |
| Files present at boot (snapshot / "image")      |               ✅               |         **86**         |
| Fresh container, nothing installed              |               ❌               |           0            |
| Setup script installs plugin **pre-boot**       |               ✅               |         **86**         |
| `SessionStart` hook installs plugin during boot |    ❌ (installed too late)     |         **0**          |

The deciding factor is ordering relative to boot-time enumeration, not the
mechanism.

## Why not a custom Docker image?

Claude Code on the web **does not support replacing the base image** with your
own Dockerfile
([docs](https://code.claude.com/docs/en/claude-code-on-the-web)). The supported
equivalent is a **Setup script**:

- It runs **before Claude Code launches**, as root on Ubuntu 24.04.
- After it completes, Anthropic **snapshots the filesystem** and reuses that
  snapshot as the starting point for later sessions (the setup-script step is
  then skipped). **That snapshot is your de-facto custom image.**

So: install the plugin in the **Setup script**, not in a `SessionStart` hook.
Everything the setup script writes to disk — `~/.claude/plugins/`, `node_modules`,
toolchains — is baked into the snapshot and present at boot in every later
session, so the plugin loads in the same session.

### Setup script vs. SessionStart hook

|                                          | Setup script                                      | SessionStart hook                                      |
| ---------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| Attached to                              | The cloud environment                             | Your repository                                        |
| Configured in                            | Cloud environment UI                              | `.claude/settings.json`                                |
| Runs                                     | **Before** Claude launches; result is snapshotted | **After** Claude launches; every session incl. resumed |
| Good for                                 | Installing/“baking” plugins & toolchains          | Per-session, cross-env work (e.g. `npm install`)       |
| Loads a plugin into the current session? | ✅ yes                                            | ❌ no (next session only)                              |

## The pattern

This repo implements it with three files:

- **`.claude/scripts/dev-team-bootstrap.sh`** — single source of truth. Installs
  npm deps, adds the marketplace, installs the plugin, runs any plugin init.
  Idempotent and non-interactive.
- **`.claude/cloud-setup.sh`** — thin stub you paste into the environment's
  **Setup script** field. It runs pre-boot and delegates to the bootstrap, so
  logic changes ship via the repo without re-pasting.
- **`.claude/hooks/session-start.sh`** — `SessionStart` hook that also delegates
  to the bootstrap. Pure **fallback**: it can't load the plugin into the current
  session, but it warms the cache for the next one and keeps deps fresh for local
  and resumed sessions.

### Apply it to another project

1. **Declare the marketplace + plugin** in the repo's `.claude/settings.json`
   (`extraKnownMarketplaces` + `enabledPlugins`), as shown above.

2. **Add a bootstrap script** (`.claude/scripts/<name>-bootstrap.sh`) that is
   idempotent and installs what you need:

   ```bash
   #!/bin/bash
   set -uo pipefail
   if command -v claude >/dev/null 2>&1; then
     claude plugin marketplace add <owner>/<repo> >/dev/null 2>&1 || true
     claude plugin install <plugin>@<marketplace> >/dev/null 2>&1 || true
   fi
   ```

3. **Add the setup-script stub** (`.claude/cloud-setup.sh`) and **paste it into
   the Cloud environment UI → Setup script field.** This is the step that makes
   the plugin load:

   ```bash
   #!/bin/bash
   set -uo pipefail
   REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
   exec bash "$REPO_ROOT/.claude/scripts/<name>-bootstrap.sh"
   ```

4. **(Optional) Keep a `SessionStart` hook** that delegates to the same
   bootstrap, guarded by `CLAUDE_CODE_REMOTE`, as a fallback for environments
   where the setup script isn't configured yet.

5. **Ensure network access** is **Trusted** (or explicitly allow the marketplace
   host, e.g. `github.com`). With **None**, the install can't reach the
   marketplace source and the plugin won't install.

### Verify it works

From a session, run a fresh headless probe and confirm the plugin's skills are
present:

```bash
claude -p "List the names of every skill available to you, one per line." --max-turns 1 \
  | grep '^<plugin-namespace>:'
```

In this repo the namespace is `dev-team:` (e.g. `dev-team:ship`). Zero matches
means the plugin didn't load — check that the setup script (not just the hook)
installs it, that it's declared in `.claude/settings.json`, and that network
access allows the marketplace source.

## Caveats

- **First session in a brand-new environment:** the setup script runs before
  boot, so the plugin loads even on that first run. Changing the setup script or
  the allowed network hosts triggers a snapshot rebuild; **resuming** an existing
  session never re-runs the setup script.
- **5-minute budget:** keep the setup script under ~5 minutes so the snapshot can
  build. Parallelize independent installs with `&` / `wait`; push very slow
  one-off downloads into a background `SessionStart` hook.
- **`|| true` on non-critical steps:** a non-zero exit from the setup script
  fails the session start. Guard best-effort commands.
- **User-level settings don't carry over:** plugins enabled only in your local
  `~/.claude/settings.json` are ignored in the cloud. Declare them in the repo's
  `.claude/settings.json`.
