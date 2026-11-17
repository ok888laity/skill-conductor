# Skill Conductor

**Let your current agent use the skills you already have when they help.** One-sentence installation prepares the required Node runtime automatically. Choose skills yourself or explicitly enable autonomous selection; connect through SDK or MCP.

The public user sentence is:

```text
Read https://raw.githubusercontent.com/ok888laity/skill-conductor/main/INSTALL.en.md and follow it to install and connect Skill Conductor, prepare its required environment automatically, use my existing skills with balanced triggering and owner confirmation, then continue my current task.
```

The complete agent contract is in [`INSTALL.en.md`](INSTALL.en.md) (Chinese: [`INSTALL.md`](INSTALL.md)). Ordinary users do not run the demo, paste multiple commands, know npm/Node, choose skill roots, or need a second model subscription.

Independent installed-package checks, the real Windows no-Node bootstrap, and an actual OpenCode max recommendation from user skill directories are documented in the [user installation test report](docs/user-install-test-report.md). Other native desktop clients are clearly distinguished from their tested configuration and stdio interfaces.

## What it does

1. Discovers **existing** project/user roots for Cursor, WorkBuddy/CodeBuddy, Qoder, DeepSeek Harness, OpenCode, Claude, Codex and shared `.agents/skills`.
2. Creates a project-local `.skill-conductor/config.json` and preserves existing custom config. With no skills it reports `no_user_skills` honestly instead of installing demos.
3. Merges only this product's MCP server into the chosen host's project config. Existing values/credentials are preserved and never printed; a conflicting server name is preserved and a stable unused name is allocated.
4. Provides `doctor` / MCP `health` and real `list_skills` inventory: runtime, roots, skill counts and reload state.
5. Defaults to **ask**: recommend to the owner, load bodies only after a real decision. `auto` is explicit. `assistance.enabled=false` always wins.
6. Uses the current host model for semantic recommendation with no second API key: the host reads candidate metadata and submits exact IDs/reasons to `prepare_skills` for validation. A recommendation is not approval.

## One-sentence install (performed by the agent)

Windows PowerShell 5.1+:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

Linux / macOS:

```sh
sh install.sh
```

The installer puts the app under the project-owned `.skill-conductor/app`, reuses existing Node 20.11+ if available, otherwise downloads official Node 24.22.3 and verifies a pinned SHA256 into `.skill-conductor/runtime`. It needs no admin and does not edit PATH/profile/TEMP/global npm. Offline/controlled testing can use `-ArchivePath` / `--archive`. `setup` runs automatically; pass `-HostName` / `--host` to generate host config.

## First-run states

| State | Meaning | Next step |
| --- | --- | --- |
| Missing runtime | Installer downloads and hash-verifies portable Node | Wait; no manual Node install |
| `ready` | Valid user skills found | Generate/reload host MCP config, continue the task |
| Host `configured` / `already_configured` | Project config written/already consistent | **Host reload/enable is required** |
| `patch_required` | Existing JSONC/invalid JSON/non-owned DSH bundle preserved | Merge the generated patch; never fake "connected" |
| `native_unverified` | DSH local bundle generated but not natively installed | Install with DSH tooling if available; otherwise require host activation |
| `no_user_skills` | No existing skills found (empty catalog is not a demo) | Ask for `--root PATH` or a real SKILL.md root; do not install a demo |
| `no_valid_user_skills` | SKILL.md files exist but metadata is unusable | Report concrete errors; do not pretend they work |

`setup` is idempotent. The old product-owned demo-only config is backed up and migrated to real skill roots, preserving owner ask/auto, the assistance switch and frequency settings, while removing demo script trust. Demo files are never deleted.

## Supported skill roots (bounded, on demand)

Project: `.cursor/skills`, `.workbuddy/skills`, `.codebuddy/skills`, `.qoder/skills`, `.dsh/skills`, `.opencode/skills`, `.claude/skills`, `.codex/skills`, `.agents/skills`, `skills`.

User: `~/.cursor/skills`, `~/.workbuddy/skills`, `~/.codebuddy/skills`, `~/.qoder/skills`, `~/.dsh/skills`, `~/.config/opencode/skills`, `~/.opencode/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`; on Windows also `%APPDATA%/opencode/skills`. Codex plugin caches are searched only for bounded `skills` directories.

- No whole-disk scan, no third-party skill installation/execution, no packaged demo root by default.
- Real-path dedupe, preserved host/scope provenance and stable namespaces/IDs.
- Hidden skill directories are detected in known roots; explicit `--include-hidden` is also supported.
- Newly discovered roots are always `trusted:false`; existing root trust is never granted by discovery.

## Platform and host support matrix

The columns keep three things separate: **official schema** (generated from documented fields), **repository protocol test** (actually launching the generated command+args and completing MCP stdio initialize/tools/list), and **native app verification** (whether the desktop/CLI app was really opened and driven). If not observed, it is not claimed.

| Host | Project config | Official schema | Stdio protocol test here | Native app |
| --- | --- | --- | --- | --- |
| Cursor | `.cursor/mcp.json`, `mcpServers` | Yes | Yes (launched generated command) | **Not claimed**; this environment did not drive Cursor desktop |
| WorkBuddy / CodeBuddy | `.workbuddy/mcp.json`, `mcpServers` | Yes | Yes | **Not claimed**; no WorkBuddy CLI on this machine |
| Qoder | `.mcp.json`; documented `.qoder/settings.json` too | Yes | Yes (Qoder CLI project config; IDE reload separate) | **Not claimed** |
| DeepSeek Harness | `.skill-conductor/integrations/deepseek-harness/`: `cordis.patch.yml` + `package.json` | Yes (Cordis `- insert:` patch + `dsh.bundle.patch`) | Yes (handshake from generated fields) | **Not claimed**; no native plugin install |
| OpenCode | `opencode.json`, `mcp.servers` | Yes | Yes (legacy structure) | 0.2.x was native-tested on 2.2.7/2.3.0; not re-claimed this round |
| Generic SDK / MCP | `.skill-conductor/mcp.json` stdio descriptor | Yes (generic protocol) | Yes | Not a native app connector |

DeepSeek Harness gets an **installable local bundle**, not `mcpServers` forced into Cordis. Mark it native only if the target DSH actually loads the bundle; otherwise report schema/protocol plus `native_unverified`. See [`docs/platform-support.md`](docs/platform-support.md) for the detailed evidence boundaries.

Operating systems: Windows (PowerShell 5.1+) and Linux (POSIX sh) have local/CI coverage. macOS has the `install.sh` entrypoint but was not run natively in this environment, so no macOS native claim. CI is Windows/Linux + Node 20/22/24, offline by default.

## Owner CLI

```text
skill-conductor setup [--host cursor|workbuddy|qoder|deepseek-harness|opencode|generic]
    [--root PATH ...] [--include-hidden] [--verify-host] [--no-host-config] [--config PATH]
skill-conductor doctor [--config PATH]
skill-conductor list [--config PATH]
skill-conductor route TASK [--config PATH] [--material FILE ...] [--phase X] [--recommend FILE]
skill-conductor run TASK [--config PATH] [--material FILE ...] [--phase X] [--mode ask|auto]
skill-conductor choose RUN_ID [--config PATH] (--skills ID,ID | --skip) [--activate-only]
skill-conductor show RUN_ID [--config PATH]
skill-conductor runs [--config PATH]
skill-conductor settings show|set ... [--config PATH]
skill-conductor interactive [--config PATH]
skill-conductor mcp [--config PATH]
```

- `setup`: discover/migrate/generate host config; idempotent; never overwrites custom config.
- `doctor`: read-only health; no demo, activation or script execution.
- `list`: real metadata; an empty catalog returns `status:"no_user_skills"`.
- `route`: recommendation only; ask mode loads no body and executes nothing.
- `run`: returns pending in ask; after owner `choose` it follows the persisted intent.
- `mcp`: stdio JSON-RPC; stdout is protocol-only, diagnostics go to stderr.
- Without init, `list`/`route`/`run`/`interactive`/`doctor`/MCP start creates a local user-skill config and reports status on stderr, with no demo copy.

`--recommend FILE` is the host-agent recommendation path:

```json
{
  "selected": [
    { "id": "cursor-project:sales-report", "reason": "English description matches the Chinese sales-report need", "confidence": 0.92 }
  ]
}
```

Only exact current catalog IDs are accepted; unknown/duplicate/blocked/over-limit/invalid fields fail explicitly. It is not approval, settings or trust.

## MCP stdio and current-host intelligence

```powershell
node bin\skill-conductor.mjs mcp --config .skill-conductor\config.json
```

Minimal newline-delimited JSON-RPC 2.0: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`. Tools:

- `health`: runtime, config, roots, skill counts and host config/reload state;
- `list_skills`: real user-skill inventory;
- `prepare_skills`: recommendation/routing, with optional `recommendation`;
- `get_run`, `activate_run`, `read_resource`.

There is no `approve` / `decide` / `set_mode` / `update_settings` tool. Approval and settings belong to the owner CLI or trusted host UI. Recommendation flow: the host reads `list_skills` metadata, then its current model submits exact IDs/reasons in `prepare_skills.recommendation`. A Chinese request can choose an English-described existing skill with no extra OpenCode or paid key. `initialize.instructions` repeats this contract.

Every `tools/call` reloads trusted config. After the owner disables `assistance.enabled`, the running MCP returns `disabled` on the next request. Autonomous execution through MCP also requires both `mcp.allowExecution` and `execution.enabled`; otherwise it only routes/activates.

## Safety boundaries

- Default ask; `auto` requires explicit config or explicit CLI/SDK authorization. Empty input, timeout and model output are not approval.
- `assistance.enabled=false` short-circuits before materials, catalog scanning, selectors or MCP recommendation.
- Activation, execution and independent verification are separate. `activated`/`handoff` is not execution success.
- Only Node entries with `execution.enabled=true` and an explicit trusted ID/allowlist run. `shell:false`, timeout kills the process tree, output/artifacts are bounded. This is not an OS sandbox.
- Materials are explicit read-only files and are DATA, not authorization. URLs are not fetched.
- Discovery reads metadata only and executes no skill scripts. Skill-specific dependencies/credentials are checked when actually used and reported honestly.
- No global user config, existing skills or other sessions are modified. Installers/generators write only project-local `.skill-conductor`, the selected project host config and necessary backups.

## Tests and known limits

```powershell
node --test tests\foundation.test.mjs tests\runtime.test.mjs tests\adaptive.test.mjs tests\mcp-cli.test.mjs tests\process-cleanup.test.mjs tests\http-selector.test.mjs tests\onboarding-cli.test.mjs tests\onboarding-setup.test.mjs
node evals\run-eval.mjs
```

- Offline tests cover discovery/dedupe/provenance/hidden roots, honest empty catalog, old demo migration/backup, custom config preservation, MCP first-run config, `health`, host JSON merge/credential non-disclosure/real stdio handshake, MCP name-collision preservation, DSH `- insert:` bundle, JSONC patch, host recommendation choosing a real user skill, unknown/blocked rejection, and installer local archive/hash failure/traversal rejection.
- `evals/run-eval.mjs` is an offline **synthetic-lexical-fixtures** development check, not semantic accuracy, a model benchmark or a production guarantee.
- No accuracy benchmark is published; semantic quality depends on the host model.
- `http` / `opencode` adapters remain optional, not user prerequisites; this round does not re-claim live model quality.
- No automatic learning, feedback-based skill rewriting, web UI or complete MCP SDK.
- macOS has a script entrypoint but was not run natively here; other desktop clients were not automatically native-tested.

## Docs

- Agent install contract: [INSTALL.en.md](INSTALL.en.md)
- Host/MCP integration and DSH bundle: [docs/host-integration.md](docs/host-integration.md)
- Platform matrix and evidence boundaries: [docs/platform-support.md](docs/platform-support.md)
- Adaptive triggering: [docs/adaptive-triggering.en.md](docs/adaptive-triggering.en.md)
- Attribution: [ATTRIBUTION.md](ATTRIBUTION.md)

## Optional demo and developer checks (not normal onboarding)

```powershell
node bin\skill-conductor.mjs demo
node bin\skill-conductor.mjs init --demo
```

The demo uses bundled first-party example skills and a synthetic CSV, runs two trusted scripts with explicit auto and independently rechecks the numbers. It calls no model. `setup` never runs the demo and never adds demo roots to the default user catalog.

## Sources and license

MIT. Design references, sources and trade-offs are in [ATTRIBUTION.md](ATTRIBUTION.md) and `research/upstream-review.json`. This is an engineering composition, not an academic novelty claim, and passing tests are not presented as production accuracy.
