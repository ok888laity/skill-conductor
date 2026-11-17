# Skill Conductor — English quickstart

Skill Conductor is a **host-neutral** Node.js component for discovering existing
`SKILL.md` packages, routing natural-language work to them, asking the owner
before use, and optionally executing explicitly trusted Node scripts or handing
instructions to a host executor. It is not an OpenCode-only plugin. OpenCode is
one optional selector/host adapter.

Default behavior is **ask**: routing produces candidates and a recommendation,
persists a pending choice, and does not activate a skill body, run a script, or
call a host executor. Autonomous mode is an explicit opt-in.

Version 0.1.1 adds local initialization, working-directory config discovery,
and caller-owned demo output. See the [onboarding and four-domain test report](docs/onboarding-test-report.md)
and [machine-readable results](docs/onboarding-test-results.json): 40 real skills,
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

## SDK

```js
import { loadConfig, prepareTask, chooseRun, verifyRun } from './src/index.mjs';

const config = await loadConfig('examples/config.demo.json');
const prepared = await prepareTask({
  config,
  task: 'inspect this CSV and write a report',
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
- Host integration: [`docs/host-integration.md`](docs/host-integration.md)
- Live development-testing report: [`docs/live-integration.md`](docs/live-integration.md)
- Attribution: [`ATTRIBUTION.md`](ATTRIBUTION.md)
- License: MIT, see [`LICENSE`](LICENSE)

Repository metadata (`OWNER/REPO`, description, topics) is filled by the
controller before the first public release.
