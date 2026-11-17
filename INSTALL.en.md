# Skill Conductor install and onboarding contract (for agents)

The user only needs to say:

> Read https://raw.githubusercontent.com/ok888laity/skill-conductor/main/INSTALL.en.md and follow it to install and connect Skill Conductor, prepare its required environment automatically, use my existing skills with balanced triggering and owner confirmation, then continue my current task.

You (the host agent) perform the installation, discovery, host wiring and one real handshake. The user does not need to know Node, npm, config fields or the demo CSV. The product needs Node only; it does not need Python, OpenCode, or a second model subscription.

## 1. Start without an existing checkout

Identify the user's current project and your actual host. Download the bootstrap into that project's `.skill-conductor/bootstrap/`, then execute it yourself. Do not ask the end user to choose a Node path, download source manually, or run a demo. Reject an existing project-state symlink/reparse point that escapes the workspace before creating the bootstrap folder.

Windows:

```powershell
$projectPath = (Get-Location).Path
$bootstrapDir = Join-Path $projectPath '.skill-conductor/bootstrap'
New-Item -ItemType Directory -Path $bootstrapDir -Force | Out-Null
$installerPath = Join-Path $bootstrapDir 'install.ps1'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/ok888laity/skill-conductor/main/install.ps1' -OutFile $installerPath
powershell -NoProfile -ExecutionPolicy Bypass -File $installerPath -ProjectPath $projectPath -HostName cursor -VerifyHost
```

Linux / macOS:

```sh
project_path="$PWD"
bootstrap_dir="$project_path/.skill-conductor/bootstrap"
mkdir -p "$bootstrap_dir"
curl -fsSL 'https://raw.githubusercontent.com/ok888laity/skill-conductor/main/install.sh' -o "$bootstrap_dir/install.sh"
sh "$bootstrap_dir/install.sh" --project "$project_path" --host cursor --verify-host
```

Replace `cursor` with your actual host: `workbuddy`, `qoder`, `deepseek-harness`, `opencode` or `generic`. Use `wget` for the same official URL if curl is unavailable. The installer fetches the app, reuses a supported Node or installs a project-local portable runtime, then sets up the user's skill catalog.

## Existing checkout entrypoints

Run the entrypoint in the user's project root. Do not edit PATH, profiles, TEMP, global npm or user home config.

Windows PowerShell 5.1+:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

Linux / macOS:

```sh
sh install.sh
```

Offline/controlled testing may use a local source archive instead of GitHub:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ArchivePath .\skill-conductor.zip
```

```sh
sh install.sh --archive ./skill-conductor.tar.gz
```

The installer:

- installs the app under the project-owned `.skill-conductor/app`;
- uses an existing Node 20.11+ if available, otherwise downloads official portable Node 24.22.3 and verifies the pinned SHA256;
- never needs admin and never edits PATH/profile/TEMP/global npm;
- validates archive entries and every final move/delete target, rejecting absolute paths, `..`, symlinks/reparse-point escapes;
- preserves existing config and runs `setup` after installation (`-NoSetup`/`--no-setup` skips it).

Installer stdout ends with `appPath`, `nodePath`, `nodeVersion`, `configPath`, `setupRan` and `nextAction`. If `setupRan=false`, run:

```text
<appPath>/bin/skill-conductor.mjs setup
```

with the reported Node executable.

## 2. Discover the user's existing skills

```text
<nodePath> <appPath>/bin/skill-conductor.mjs setup --host <cursor|workbuddy|qoder|deepseek-harness|opencode|generic>
```

- Without `--host`, only the user-skill config is created/updated.
- `--root PATH` may be repeated for explicit additional roots.
- `--include-hidden` only when a hidden root really needs it; the discoverer also detects hidden skill directories under known roots.
- `setup` is idempotent. Existing custom config is never silently overwritten; the old product-owned demo-only scaffold is backed up, migrated, and demo script trust is removed.
- Discovery checks known project/user roots only. It does not scan a whole disk, install or execute third-party skills.
- Every newly discovered root is `trusted:false` and execution stays disabled. Discovery is not trust.

### Translate setup status

| `status` / `setupStatus` | Meaning | Agent action |
| --- | --- | --- |
| `ready` | Valid user skills found | Continue with host wiring and the task |
| `no_user_skills` | No user skills found (an empty catalog is not a demo) | Tell the user honestly; ask for a skill root or `--root PATH`; do not install a demo |
| `no_valid_user_skills` | SKILL.md files exist but metadata is unusable | Report the concrete files/errors; do not pretend they are usable |
| `existing_custom_config_preserved` | Existing custom config was preserved | Do not overwrite; let the user add roots if needed |
| `existing_custom_config_invalid` | Custom config is invalid and was not modified | Report it; user must fix or back up and rerun |
| `migrated_demo_scaffold` | Old demo-only config was backed up and migrated | Explain demo files remain but are no longer routed/trusted |

## 3. Host config states

`setup --host X` merges only this product's project config entry. It never writes home/global host files and never prints existing credentials.

| State | Meaning | Agent action |
| --- | --- | --- |
| `configured` / `already_configured` | Project host config written/already consistent | Ask the user to reload/enable that host's MCP server; do not claim native app verification |
| `patch_required` | Existing JSONC/invalid JSON/non-owned DSH bundle was preserved | Give the generated patch to the user/agent and state the next action |
| `native_unverified` | DSH local bundle generated but not installed into DSH | Install with DSH plugin tooling if available, otherwise require host activation; keep nativeVerified=false |
| `verification: "schema-only"` | Structure/command checked | Host reload is still required |
| `verification.status: "protocol_verified"` | Generated command actually launched and completed MCP initialize/tools/list | Still not native-app verification |

For a real stdio handshake add `--verify-host`, or have the host MCP SDK launch the generated `command`+`args`.

DeepSeek Harness generates a local bundle:

```text
.skill-conductor/integrations/deepseek-harness/cordis.patch.yml
.skill-conductor/integrations/deepseek-harness/package.json
```

`cordis.patch.yml` is a `- insert:` patch operation document; `package.json` contains `dsh.bundle.patch`. It is not generic `mcpServers` JSON, and no unrelated workspace package.json is modified. If native installation/reload was not performed, report `native_unverified`.

## 4. Health and real inventory

```text
<nodePath> <appPath>/bin/skill-conductor.mjs doctor
```

or the MCP `health` / `list_skills` tools. The report contains:

- Node version/path, platform;
- config path, ask/auto policy, assistance total switch;
- roots, skill counts, valid/invalid counts;
- host config presence/configured/reload state;
- explicit `nextAction` for `no_user_skills`;
- no demo run, no skill activation, no script execution.

A first MCP start with no config creates a local config for the current project; diagnostics go to stderr and stdout remains JSON-RPC protocol-only.

## 5. Use the current host model for recommendation (no extra key)

Two steps. A recommendation is never approval.

1. Call `list_skills` or `health` and read real candidate metadata: `id`, `name`, `description`, `tags`, `triggers`, `blocked`, etc.
2. Let the current host model choose, then call:

```json
{
  "name": "prepare_skills",
  "arguments": {
    "task": "the user's Chinese task",
    "recommendation": {
      "selected": [
        { "id": "cursor-project:sales-report", "reason": "English description matches the Chinese sales-report need", "confidence": 0.9 }
      ]
    }
  }
}
```

- Exact catalog IDs only. Unknown, duplicate, blocked, over-limit or invalid-confidence entries are rejected explicitly.
- The recommendation changes only pending recommendations. It never changes ask/auto policy, settings or trust.
- In ask mode the owner still decides through `choose`, an owner UI, or a trusted SDK callback.
- A Chinese request may choose an English-described existing skill; no OpenCode or paid API key is required.
- `assistance.enabled=false` always wins; recommendations cannot bypass it.

The MCP `initialize.instructions` field repeats this flow.

## 6. Finish and return to the user's task

- If `ready` and the host reloaded: call `prepare_skills`, then show `status:"awaiting_choice"`, candidates, reasons and blockers to the user.
- `no_match`: explain (`no_user_skills` or selector abstention). Do not show an empty approval prompt.
- `awaiting_choice`: wait for the owner. The agent must not self-approve. Decisions use:

```text
<nodePath> <appPath>/bin/skill-conductor.mjs choose <runId> --skills ID,ID --config <configPath>
<nodePath> <appPath>/bin/skill-conductor.mjs choose <runId> --skip --config <configPath>
```

- Activation alone is not execution or independent verification. Only explicitly trusted Node scripts execute; discovery never grants trust. Skills without executable entries are handed to the host executor.
- Check skill-specific dependencies/credentials when that skill is actually used. Report missing requirements honestly; a host agent may perform scoped repair, but must not claim they were installed.

## 7. Do not

- Make the demo, sample CSV or demo scripts part of first use.
- Install unreviewed third-party skills or execute scripts during discovery.
- Read or print credentials, or echo existing config values into logs.
- Modify global host config; write project-local paths only.
- Claim Cursor/WorkBuddy/Qoder/DeepSeek Harness native apps ran. Report only observed schema or stdio handshakes.
- Turn `no_user_skills` into "ready" or fill an empty catalog with fake skills.

## 8. Supported skill roots (discovered on demand)

Project: `.cursor/skills`, `.workbuddy/skills`, `.codebuddy/skills`, `.qoder/skills`, `.dsh/skills`, `.opencode/skills`, `.claude/skills`, `.codex/skills`, `.agents/skills`, `skills`.

User: `~/.cursor/skills`, `~/.workbuddy/skills`, `~/.codebuddy/skills`, `~/.qoder/skills`, `~/.dsh/skills`, `~/.config/opencode/skills`, `~/.opencode/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`; Windows also `%APPDATA%/opencode/skills`. Codex plugin caches are searched only for bounded `skills` directories.

Discovery preserves host/scope provenance and stable namespaces, deduplicates real paths, and never grants trust to an existing root.

## 9. Optional developer demo

`node bin/skill-conductor.mjs demo` / `init --demo` is a repository example and development check only. It is not part of normal onboarding and `setup` never runs it.
