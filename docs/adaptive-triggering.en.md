# Adaptive triggering (v0.2.0)

v0.2 adds a host-neutral **cheap-before-expensive** trigger gate. It first classifies explicit host task/event/file-name signals locally and only then reads materials, scans the skill catalog and calls a selector. It never calls an extra model just to decide whether to route.

This document describes the actual implementation and defaults. It is not an accuracy benchmark.

## 1. Total switch independent of approval policy

```json
{
  "assistance": {
    "enabled": true,
    "profile": "balanced"
  },
  "policy": { "mode": "ask" }
}
```

- `assistance.enabled=false` is the owner total switch. `prepareTask` short-circuits **before reading materials, scanning catalogs, or calling selectors/executors** and returns `status: "disabled"` with `reasonCode: "disabled_total_switch"`, never `no_match`.
- While off, `chooseRun`, `resumeRun`, MCP `activate_run` and `read_resource` reject new activation/execution. Pending approvals cannot bypass the switch. `get_run`/`runs`/`show` remain readable.
- Turning assistance off does not retract context already delivered to a host and does not roll back completed operations.
- `policy.mode` (`ask`/`auto`) still controls only who approves and whether trusted scripts may run. Changing trigger frequency never switches ask/auto.

Old configs without `assistance` migrate to `enabled=true, profile=balanced`; this is a safe compatibility default, not a new user authorisation.

## 2. Frequency profiles

| profile | New-task auto check | Ambiguous text | Phase/family/requirements change | Failure retry | Delivery recheck | Per-task budget |
|---|---|---|---|---|---|---|
| `manual` | no | no | no | no | no | manual bypasses budget |
| `conservative` | only explicit specialized/file or `needsSkill` | no | family/requirements; phase off by default | threshold 2 | no | 4 |
| `balanced` (default) | yes, with cautious ambiguity fallback | yes | yes | threshold 2 | no | 12 |
| `proactive` | yes | yes | yes | threshold 2 | yes by default | 24 |
| `custom` | from `assistance.triggers` | configurable | configurable | configurable | configurable | configurable |

`init` writes only `enabled` and `profile`; it does not pin balanced trigger/budget defaults as owner overrides. Switching profile therefore applies the selected preset, while explicit advanced values remain as overrides. Owner-CLI settings are the only supported write path:

```powershell
node bin\skill-conductor.mjs settings show --config .skill-conductor\config.json
node bin\skill-conductor.mjs settings set assistance.enabled false --config .skill-conductor\config.json
node bin\skill-conductor.mjs settings set assistance.profile conservative --config .skill-conductor\config.json
node bin\skill-conductor.mjs settings set assistance.triggers.failureThreshold 2 --config .skill-conductor\config.json
node bin\skill-conductor.mjs settings set assistance.budget.maxAutomaticChecksPerTask 8 --config .skill-conductor\config.json
```

`settings set` accepts known keys only, validates the entire candidate config first, and writes atomically. A failed update never partially overwrites the file. Other user keys and `policy.mode` are preserved. MCP has no settings, approval or switch-to-auto tool.

## 3. Event interface

```js
const { run, pendingChoice, trigger } = await prepareTask({
  config,
  task: 'Continue organising the material and produce a summary',
  taskId: 'task-2026-001',        // explicit task identity; isolates state
  sessionId: 'host-session-7',    // optional host session
  event: 'routine_continuation',
  phase: 'summarize',
  files: ['./notes.md'],
  activity: {
    needsSkill: false,
    materialFamilies: ['markdown'],
    requirementsKey: 'summary-v1',
    // errorFingerprint: 'build-tsc-2345',
    // errorCount: 2,
    // manualRequest: false,
  },
  selector,
});
```

Supported `event` values: `new_task`, `routine_continuation`, `phase_change`, `material_family_change`, `requirements_change`, `repeated_failure`, `delivery`, `manual_request`.

`activity` carries **host signals**, not observed telemetry about all agent behaviour. Without `taskId`, documented v0.1 one-shot behavior is preserved (except the total switch and manual profile). Without an explicit phase, ordinary wording edits, file mtimes or observations are not guessed to be phase changes.

## 4. Structured explanations

Every call returns a `trigger` object:

```json
{
  "schema": "skill-conductor/trigger/v0.1",
  "action": "trigger",
  "event": "new_task",
  "reasonCode": "new_task_specialized",
  "explanation": "A new task explicitly needs file processing or a specialized capability.",
  "profile": "balanced",
  "automatic": true,
  "counters": { "gateChecks": 1, "selectorCalls": 1, "cacheReuse": 0, "ownerPrompts": 1, "executions": 0 },
  "budget": { "used": 1, "limit": 12, "exhausted": false }
}
```

Main codes:

- Trigger: `new_task_specialized`, `new_task_needs_skill`, `new_task_ambiguous_cautious`, `phase_changed`, `material_family_changed`, `requirements_changed`, `repeated_failure_threshold_reached`, `delivery_recheck`, `manual_request`, `cache_invalidated_*`.
- Suppress: `new_task_smalltalk_skip`, `new_task_simple_skip`, `phase_change_disabled`, `delivery_recheck_disabled`, `repeated_failure_threshold`, `repeated_failure_deduped`, `no_match_suppressed`, `owner_skipped_phase`, `budget_exhausted`, `manual_profile_passive`.
- Reuse/other: `routine_reuse`, `pending_unchanged`, `pending_completed_reuse`, `disabled_total_switch`.

A suppression is not a fabricated `no_match`. Budget exhaustion, a below-threshold failure and an owner skip all preserve host work.

## 5. Deduplication, cache and execution boundary

- State is isolated by **workspace + explicit `sessionId` + `taskId`**. The same taskId in a new session cannot inherit approval, pending, no-match, skip, context or budget, and "same task" is never implicit approval. Session files use a SHA-256 task key; identifiers and persistent collections are bounded.
- An unchanged pending request returns the same `runId` without a new run, prompt or selector call. `ownerPrompts` counts only distinct pending choices created.
- A same-phase routine continuation with an activated decision returns `status: "reused"`, `sourceRunId`, `reused: true`, the existing `context`, `executedForThisEvent: false` and `execution.status: "not_executed"`. **No script is re-executed.**
- New same-format input may reuse the skill choice, but old computed outputs are never presented as results for new data. Send `event: "manual_request"` to force a fresh check.
- Before reuse, config/trust fingerprints, directory signatures and selected SKILL.md/sidecar/script hashes are validated. Changes invalidate the cache. Real activation keeps all existing stale-decision/hash/trust checks.
- Owner skip suppresses the **current phase**. A new material family, requirements change, new phase or explicit manual request can recheck.

## 6. Budget, failure and delivery defaults

- Default automatic expensive-check budget is 12 per task (`proactive` 24, `conservative` 4). `0` means unlimited. Only actual discovery/selection consumes budget; deduped pending and cache reuse do not. Manual requests bypass but do not consume it.
- Repeated-failure threshold defaults to 2 (configurable 1–20). After one trigger for an `errorFingerprint`, it does not repeat until a material, requirements or phase change.
- Delivery recheck is off by default in balanced/conservative/manual and on in proactive. `deliveryRecheck` is the primary key; `delivery` is a compatibility alias.
- Counters are lightweight facts: gate checks, actual selector calls, cache reuse, owner prompts and executions. No latency or accuracy claims are made.

## 7. Compatibility and limitations

- Existing one-shot `prepareTask` consumers without `taskId` keep their old behavior. They do not get adaptive deduplication/budget and are affected only by the total switch/manual profile.
- The gate is deterministic lexical/file-name heuristics, **not a semantic model**, and no calibrated confidence is claimed. Chinese and English share the cautious fallback; it does not depend on ASCII word boundaries.
- Without `taskId` the component cannot reliably distinguish the same task from a new task and does not pretend to persist task state.
- MCP reloads trusted config on every `tools/call`, so an owner CLI change to `assistance.enabled=false` takes effect on the next request of a running MCP process. A malformed config fails the request instead of falling back to the previous trusted copy. `prepare_skills` validates `additionalProperties:false` first: top-level `mode`, `assistance` and similar settings fields produce an explicit `isError`, never a plausible successful `disabled` response, and never reach the OFF short-circuit as accepted arguments.
- MCP carries task event data only. It cannot mutate settings, approve or switch to auto.
- This release does not implement cross-task approval reuse. Each ask decision still covers one run. The user did not confirm a broader reconfirmation/error-timing policy, so only configurable defaults are documented here.
