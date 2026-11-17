#!/usr/bin/env node
/**
 * Non-OpenCode SDK example: deterministic custom selector + host executor.
 *
 * The selector below is labelled deterministic-demo-selector. It is NOT a
 * semantic model. Ask policy remains the default; without --approve-demo the
 * script only prints the pending choice. --approve-demo simulates an owner/host
 * approval for this local fixture and hands instructions to a host callback.
 *
 *   node examples/custom-selector-host-executor.mjs
 *   node examples/custom-selector-host-executor.mjs --approve-demo
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, normalizeConfig } from '../src/config.mjs';
import { prepareTask, chooseRun } from '../src/router.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loaded = await loadConfig(path.join(root, 'examples', 'config.demo.json'));

// Disable bundled execution for this example so the host executor is actually used.
const config = await normalizeConfig(
  {
    roots: loaded.roots,
    selector: {
      mode: 'lexical',
      maxCandidates: loaded.selector.maxCandidates,
      minScore: loaded.selector.minScore,
      ambiguityGap: loaded.selector.ambiguityGap,
      semanticAllThreshold: loaded.selector.semanticAllThreshold,
      semanticPrefilterLimit: loaded.selector.semanticPrefilterLimit,
      maxSelection: loaded.selector.maxSelection,
      timeoutMs: loaded.selector.timeoutMs,
    },
    policy: { mode: 'ask' },
    capabilities: loaded.capabilities,
    assistance: loaded.assistance,
    execution: {
      enabled: false,
      trustedSkillIds: [],
      allowlist: [],
      runDir: path.join(root, 'runs'),
    },
    materials: loaded.materials,
    mcp: loaded.mcp,
  },
  { baseDir: root, configPath: loaded.configPath },
);

const selector = async ({ candidates }) => {
  const csv = candidates.find((candidate) => candidate.name === 'csv-inspector' && !candidate.blocked);
  if (!csv) return { selected: [], abstainReason: 'demo selector found no unblocked csv-inspector' };
  return {
    selected: [{ id: csv.id, reason: 'deterministic-demo-selector: csv-inspector fixture match', confidence: 0.6 }],
  };
};

const { run, pendingChoice } = await prepareTask({
  config,
  task: '请分析 CSV 数据',
  files: [path.join(root, 'data', '销售 数据.csv')],
  phase: 'inspection',
  taskId: 'custom-selector-demo-task',
  event: 'new_task',
  selector,
});

if (!pendingChoice) {
  console.log(JSON.stringify({ status: run.status, note: 'ask policy did not produce a pending choice' }, null, 2));
  process.exit(0);
}

console.log(
  JSON.stringify(
    {
      status: run.status,
      selector: run.selector,
      recommendation: run.recommendation,
      candidates: run.candidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        recommended: candidate.recommended,
        blocked: candidate.blocked,
      })),
      approval: 'not granted by this script; rerun with --approve-demo to simulate a trusted host decision',
    },
    null,
    2,
  ),
);

if (!process.argv.includes('--approve-demo')) process.exit(0);

let hostCalls = 0;
const executed = await chooseRun({
  config,
  runId: run.runId,
  skills: run.recommendation.selected.map((entry) => entry.id),
  decisionToken: run.planHash,
  decidedBy: 'demo-host-owner',
  executor: async ({ skill, artifactDir }) => {
    hostCalls += 1;
    return {
      ok: true,
      output: `host executor received ${skill.id} instructions (${skill.body.length} body chars); artifacts=${artifactDir}`,
    };
  },
});

console.log(
  JSON.stringify(
    {
      status: executed.status,
      states: executed.states,
      hostCalls,
      execution: executed.execution,
      note: 'host callback output is execution evidence, not independent verification',
    },
    null,
    2,
  ),
);
