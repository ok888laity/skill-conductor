# Reproducing the optional live integration tests

The core SDK, CLI, offline tests and demo need only Node.js. The live integration harness is separate development tooling and uses real model sessions. The published observations used OpenCode 2.2.7 and `opencode-go/deepseek-v4.1-flash#low` on Windows. They describe synthetic integration cases, with temporary routing/capability overlays recorded in the report.

## Prepare an isolated source tree

Run from this repository. Downloaded skills stay in `integration-temp/`; global skill directories are unnecessary. The following commands select only the tested packages and pin the recorded upstream commits:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/anthropics/skills.git integration-temp/anthropic
git -C integration-temp/anthropic sparse-checkout set skills/pdf skills/docx skills/xlsx skills/doc-coauthoring skills/frontend-design skills/webapp-testing
git -C integration-temp/anthropic fetch --depth 1 origin e4bb5d960d87126ff3b3a8af1a104b7db67560ba
git -C integration-temp/anthropic checkout --detach FETCH_HEAD

git clone --depth 1 --filter=blob:none --sparse https://github.com/obra/superpowers.git integration-temp/superpowers
git -C integration-temp/superpowers sparse-checkout set skills/systematic-debugging skills/test-driven-development skills/verification-before-completion
git -C integration-temp/superpowers fetch --depth 1 origin 22f0b463e7a5e579904dd6211a520321035526f7
git -C integration-temp/superpowers checkout --detach FETCH_HEAD

git clone --depth 1 --filter=blob:none --sparse https://github.com/vercel-labs/agent-skills.git integration-temp/vercel
git -C integration-temp/vercel sparse-checkout set skills/web-design-guidelines
git -C integration-temp/vercel fetch --depth 1 origin 1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62
git -C integration-temp/vercel checkout --detach FETCH_HEAD
```

Read the downloaded instructions and licenses before enabling their execution. They remain upstream test inputs and are excluded from this repository's release.

## Generate synthetic inputs

Use a Python environment with `reportlab`, `python-docx`, `openpyxl` and `pypdf`. The generator itself uses the first three; the independent PDF validator uses `pypdf`.

```sh
node scripts/generate-fixtures.mjs --out integration-temp/fixtures
```

Create `integration-audit/` and copy `integration-temp/fixtures/fixture-truth.generated.json` to `integration-audit/fixture-truth.json`. For PowerShell:

```powershell
New-Item -ItemType Directory -Force integration-audit | Out-Null
Copy-Item -LiteralPath integration-temp/fixtures/fixture-truth.generated.json -Destination integration-audit/fixture-truth.json
```

The oracle is for independent checking and must stay outside executor workspaces.

## Configure executables and run explicitly

The harness accepts `SKILL_CONDUCTOR_OPENCODE_CLI`, `SKILL_CONDUCTOR_PYTHON` and `SKILL_CONDUCTOR_LIVE_MODEL`. Use an available model/provider in your own OpenCode installation. The recorded results use the model named above.

```sh
node scripts/live-integration.mjs --routing
node scripts/live-integration.mjs --downstream
node scripts/live-report.mjs
```

This uses real OpenCode run/session invocations and may consume provider usage. The default CI never runs the live harness. Session invocation counts differ from underlying provider requests because one agent session may contain multiple tool/model turns.

Results and original attempt traces are written under `integration-audit/`. Failed validations and original records remain available; focused case selection and offline revalidation avoid repeating successful live sessions. See the script options and `SKILL_CONDUCTOR_DOWNSTREAM_CASES` / `SKILL_CONDUCTOR_REVALIDATE_ATTEMPTS` for targeted investigation.

## Finish the test workflow

Stop only test-owned processes, retain the artifacts and traces needed for verification, and remove the exact `integration-temp/` tree. Use the resolved project path when deleting test files. Preserve your original skill directories and compare their file hashes if you need an environment restoration audit.

This development run removed all 10 temporary skill packages and its known scratch backup, retained 27 output/input files as audit evidence, and compared 580 original skill-related files: added 0, removed 0, changed 0. The public restoration summary is in [environment-restoration.json](environment-restoration.json).
