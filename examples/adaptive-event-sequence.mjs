#!/usr/bin/env node
/**
 * Reproducible adaptive trigger counters.
 *
 * This example compares a naive "route every step" baseline with the adaptive
 * gate over the same deterministic event sequence. The selector is a synthetic
 * callback fixture: these are call counters, NOT live semantic accuracy and NOT
 * a benchmark. Run with:
 *   node examples/adaptive-event-sequence.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTaskSession } from '../src/adaptive.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { prepareTask } from '../src/router.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sequence = JSON.parse(await fs.readFile(path.join(here, 'adaptive-event-sequence.json'), 'utf8'));
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-conductor-adaptive-'));

async function writeFixture() {
  const skillDir = path.join(tempRoot, 'skills', 'summary-helper');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: summary-helper\ndescription: "Summarize an explicitly supplied Markdown material."\n---\n\nSynthetic instruction fixture; no script is present or executed.\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(skillDir, 'conductor.json'),
    `${JSON.stringify({ triggers: ['Markdown', '摘要', '总结'], tags: ['markdown'] }, null, 2)}\n`,
    'utf8',
  );
}

async function makeConfig() {
  return normalizeConfig(
    {
      roots: [{ path: path.join(tempRoot, 'skills'), namespace: 'example', trusted: false }],
      selector: { mode: 'lexical', minScore: 0.01 },
      policy: { mode: 'auto' },
      capabilities: ['filesystem.read'],
      assistance: {
        enabled: true,
        profile: 'balanced',
        triggers: { deliveryRecheck: false, failureThreshold: 2 },
        budget: { maxAutomaticChecksPerTask: 20 },
      },
      execution: { enabled: false, runDir: path.join(tempRoot, 'runs') },
      materials: { allowRoots: [tempRoot] },
      mcp: { allowExecution: false },
    },
    { baseDir: tempRoot },
  );
}

function makeSelector(counter) {
  return async ({ candidates }) => {
    counter.calls += 1;
    const candidate = candidates[0];
    if (!candidate) return { selected: [], abstainReason: 'synthetic fixture has no candidate' };
    return {
      selected: [{ id: candidate.id, reason: 'synthetic callback fixture', confidence: 0.8 }],
    };
  };
}

try {
  await writeFixture();
  const config = await makeConfig();
  const material = path.join(tempRoot, 'notes.md');
  await fs.writeFile(material, '# 材料\n\n这是同一格式的确定性合成输入。\n', 'utf8');

  const baseline = { calls: 0 };
  for (const step of sequence.events) {
    await prepareTask({
      config,
      task: sequence.task,
      files: [material],
      phase: step.phase,
      event: step.event,
      activity: step.activity ?? null,
      selector: makeSelector(baseline),
    });
  }

  const adaptive = { calls: 0 };
  for (const step of sequence.events) {
    await prepareTask({
      config,
      task: sequence.task,
      files: [material],
      phase: step.phase,
      event: step.event,
      activity: step.activity ?? null,
      taskId: sequence.taskId,
      selector: makeSelector(adaptive),
    });
  }

  const session = await loadTaskSession({ config, taskId: sequence.taskId });
  const result = {
    label: sequence.label,
    events: sequence.events.length,
    naivePerStepBaseline: {
      selectorCalls: baseline.calls,
      note: 'No taskId: documented legacy one-shot behavior, so every step performs discovery and selection.',
    },
    adaptive: {
      selectorCalls: adaptive.calls,
      gateChecks: session.counters.gateChecks,
      cacheReuse: session.counters.cacheReuse,
      ownerPrompts: session.counters.ownerPrompts,
      executions: session.counters.executions,
      budget: { used: session.budget.used, limit: session.budget.limit },
    },
    selectorCallsAvoided: baseline.calls - adaptive.calls,
    boundary:
      'Synthetic callback counters only. They show gate/cache behavior, not model routing quality or calibrated confidence.',
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}
