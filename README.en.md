# Skill Conductor — English quickstart

Skill Conductor is a **host-neutral** Node.js component for discovering existing
`SKILL.md` packages, routing natural-language work to them, asking the owner
before use, and optionally executing explicitly trusted Node scripts or handing
instructions to a host executor. It is not an OpenCode-only plugin. OpenCode is
one optional selector/host adapter.

Default behavior is **ask**: routing produces candidates and a recommendation,
persists a pending choice, and does not activate a skill body, run a script, or
call a host executor. Autonomous mode is an explicit opt-in.

Version 0.2.0 adds an **adaptive trigger gate** that is independent of the
ask/auto approval policy. With task identity and host events, a cheap local
assessment controls when discovery and selection run; ambiguous tasks use the
documented cautious fallback.
Per-task sessions add pending deduplication, no-match/skip suppression, a
configurable expensive-check budget, failure thresholds, and cache/context reuse
that never re-executes scripts. Full behavior, defaults and limitations:
[`docs/adaptive-triggering.en.md`](docs/adaptive-triggering.en.md).

The [independent adaptive test report](docs/adaptive-test-report.md) and
[machine-readable results](docs/adaptive-test-results.json) cover installed
SDK/CLI/MCP checks, a fixed 20-event callback comparison (20 selections to 3),
and real max-model selector integration. These are integration checks, not
production accuracy, latency, or cost guarantees.

The prior 0.1.1 onboarding evidence remains available in the
[onboarding and four-domain test report](docs/onboarding-test-report.md) and
[machine-readable results](docs/onboarding-test-results.json): 40 real skills,
64 frozen development tasks, four audited native executions, and preserved failures.

## Requirements

Optional real-skill test setup and cleanup are documented in [docs/reproduce-live-tests.md](docs/reproduce-live-tests.md).

- Node.js >= 20.11
- No runtime dependencies

## Install and first run

Node.js >= 20.11 is required (verified on Node 24.22.3 / npm 11.19.1). The bare
npm registry name `skill-conductor` is **not available (E404)**; use the public
GitHub HTTPS tarball instead of `npm install skill-conductor`.

One-shot run from any working directory (outputs stay in that directory):

```sh
npx --yes --package=https://github.com/ok888laity/skill-conductor/archive/refs/heads/main.tar.gz skill-conductor demo
```

Global install, then initialize and run:

```sh
npm install --global https://github.com/ok888laity/skill-conductor/archive/refs/heads/main.tar.gz
skill-conductor init --demo
skill-conductor demo
```

`init` writes `.skill-conductor/config.json` and an empty `./skills` root in the
current directory, keeps policy at `ask`, and leaves `execution.enabled=false`
(no script is trusted). `init --root PATH` uses an existing skill root. Existing
files are never overwritten. `init --demo` copies the four bundled first-party
demo skills and the synthetic CSV into `.skill-conductor/demo/` and trusts only
`demo:csv-inspector` and `demo:markdown-report`; policy is still `ask`, and the
`demo` command itself is the explicit auto opt-in.

Installed commands search for `.skill-conductor/config.json` and then
`skill-conductor.config.json` from the working directory upward. An explicit
`--config PATH` always wins. `demo` also works without init, but its runs and
artifacts go to `.skill-conductor/runs/` under the caller, never into the
installed package. With an explicit config, that config's `execution.runDir` is
preserved.

## Quickstart from the source tree (offline demo)

```sh
node bin/skill-conductor.mjs init --demo
node bin/skill-conductor.mjs demo
```

The demo executes two explicitly trusted demo scripts and independently
verifies the CSV row count and totals. It does not call a model.

## Route first, then choose

```sh
node bin/skill-conductor.mjs route "分析这个 CSV 并生成 Markdown 报告" \
  --config examples/config.demo.json --material "data/销售 数据.csv"
node bin/skill-conductor.mjs choose <runId> \
  --config examples/config.demo.json --skills demo:csv-inspector,demo:markdown-report
```

`route` and ask-mode `run` return `awaiting_choice` when a skill is applicable.
A separate trusted owner action (`choose`, an owned UI, or SDK `chooseRun`) must
decide. Model output is a recommendation, never approval. If the selector
abstains, the terminal status is `no_match` with candidates/abstainReason
preserved; it is not an empty approval prompt.

## Adaptive triggering in one minute

`assistance.enabled` is the owner total switch. When false, `prepareTask` returns
`status: "disabled"` **before** reading materials, scanning catalogs, or calling
selectors/executors; `chooseRun`, `resumeRun` and MCP activation cannot bypass it.
History stays readable. This is independent of `policy.mode` ask/auto.

Profiles are `manual`, `conservative`, `balanced` (default), `proactive` and
`custom`. Without `taskId`, documented v0.1 one-shot behavior is preserved.
With an explicit `taskId` and event:

```js
const { run, pendingChoice, trigger } = await prepareTask({
  config,
  task: 'continue organising this material',
  taskId: 'task-2026-001',
  sessionId: 'host-session-7',
  event: 'routine_continuation', // or new_task, phase_change, ... manual_request
  phase: 'summarize',
  activity: { needsSkill: false, requirementsKey: 'summary-v1' },
  selector,
});
```

Task state is scoped by workspace + `sessionId` + `taskId`; the same taskId in a
new session starts a fresh check and never inherits skip, pending, no_match,
context or budget. `init` stores only `enabled`/`profile`, so switching profile
applies that preset instead of being blocked by pinned balanced defaults.

Same-phase routine steps with an activated decision return `status:"reused"`,
`sourceRunId` and existing `context`, with `executedForThisEvent:false`; no
selector or script runs. Same-format new input reuses the skill choice but never
treats old computed output as a new result. Material/requirements/phase changes,
changed skill/script hashes, config/trust changes or catalog root changes
invalidate the cache. An unchanged pending request returns the same run without
a duplicate prompt. A skip suppresses the current phase; a real `no_match` is
suppressed for unchanged continuations.

Owner settings CLI only:

```sh
node bin/skill-conductor.mjs settings show --config .skill-conductor/config.json
node bin/skill-conductor.mjs settings set assistance.enabled false --config .skill-conductor/config.json
node bin/skill-conductor.mjs settings set assistance.profile conservative --config .skill-conductor/config.json
```

MCP exposes task event data but no settings, approval or switch-to-auto tool. A
running MCP process reloads trusted config on every `tools/call`.

Reproducible counters (synthetic callback, not live accuracy):

```sh
node examples/adaptive-event-sequence.mjs
```

## SDK

```js
import { loadConfig, prepareTask, chooseRun, verifyRun } from './src/index.mjs';

const config = await loadConfig('examples/config.demo.json');
const prepared = await prepareTask({
  config,
  task: 'inspect this CSV and write a report',
  taskId: 'task-2026-001',
  event: 'new_task',
  files: ['data/销售 数据.csv'],
  mode: 'ask',
});

// Show prepared.pendingChoice to the owner. After a real decision:
const run = await chooseRun({
  config,
  runId: prepared.run.runId,
  skills: ['demo:csv-inspector', 'demo:markdown-report'],
  decisionToken: prepared.run.planHash,
});

// Verification must independently inspect the output. Execution alone is not
// verification. See README.md for a CSV recomputation example.
```

Custom selector and host executor callbacks are documented in
[`docs/host-integration.md`](docs/host-integration.md) and
[`examples/`](examples/).

## Configuration sketch

```json
{
  "roots": [{ "path": "../skills", "namespace": "demo", "trusted": true }],
  "selector": { "mode": "lexical" },
  "policy": { "mode": "ask" },
  "assistance": {
    "enabled": true,
    "profile": "balanced"
  },
  "capabilities": ["filesystem.read", "filesystem.write"],
  "execution": {
    "enabled": false,
    "trustedSkillIds": [],
    "runDir": "../runs"
  },
  "materials": { "allowRoots": [".."] }
}
```

Selector modes are `lexical` (offline, explicitly not semantic), `http`
(OpenAI chat-completions-compatible endpoint), `opencode` (optional CLI
adapter), or an SDK callback. Paths are resolved relative to the config file.

## What this project does not claim

- No accuracy benchmark or held-out evaluation is published.
- A loaded `SKILL.md` is an instruction package, not a callable function.
- Activation, execution, and independent verification are separate states.
- Trusted script execution is not an OS sandbox.
- Third-party skill packages used during development testing are not vendored.

## Docs

- Chinese README: [`README.md`](README.md)
- Adaptive triggering (English): [`docs/adaptive-triggering.en.md`](docs/adaptive-triggering.en.md)
- Host integration: [`docs/host-integration.md`](docs/host-integration.md)
- Live development-testing report: [`docs/live-integration.md`](docs/live-integration.md)
- Attribution: [`ATTRIBUTION.md`](ATTRIBUTION.md)
- License: MIT, see [`LICENSE`](LICENSE)

Repository metadata (`OWNER/REPO`, description, topics) is filled by the
controller before the first public release.
