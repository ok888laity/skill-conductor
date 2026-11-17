import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareTask, chooseRun, resumeRun, verifyRun } from '../src/router.mjs';
import { makeTempDir, makeConfig, writeSkill } from './helpers.mjs';

async function fixture(t, options = {}) {
  const dir = await makeTempDir(t, 'runtime');
  await writeSkill(dir, {
    name: 'calculate',
    triggers: ['calculate', '计算'],
    script: "process.stdout.write(JSON.stringify({actual:6*7}));",
  });
  const { config, raw } = await makeConfig(dir, { skills: ['calculate'], ...options });
  const selector = async ({ candidates }) => ({
    selected: [{ id: candidates[0].id, reason: 'Fixture selector, not a semantic model', confidence: 0.9 }],
  });
  return { dir, config, raw, selector };
}

test('ask mode does not activate or execute before a real decision', async (t) => {
  const f = await fixture(t);
  let executorCalls = 0;
  const result = await prepareTask({
    config: f.config,
    task: '请计算 6*7',
    selector: f.selector,
    executor: async () => {
      executorCalls += 1;
      return { ok: true };
    },
  });
  assert.equal(result.run.status, 'awaiting_choice');
  assert.equal(result.run.activation, null);
  assert.equal(result.run.states.executed, false);
  assert.equal(executorCalls, 0);
  await assert.rejects(resumeRun({ config: f.config, runId: result.run.runId }), /decision/i);
});

test('ask no-match is terminal and does not create an empty approval hurdle', async (t) => {
  const f = await fixture(t);
  let executorCalls = 0;
  const result = await prepareTask({
    config: f.config,
    task: '明天天气怎么样',
    selector: async () => ({ selected: [], abstainReason: 'fixture selector found no applicable skill' }),
    executor: async () => {
      executorCalls += 1;
      return { ok: true };
    },
  });
  assert.equal(result.run.status, 'no_match');
  assert.equal(result.pendingChoice, null);
  assert.equal(result.run.states.awaitingChoice, false);
  assert.equal(result.run.states.noMatch, true);
  assert.equal(result.run.states.activated, false);
  assert.equal(result.run.states.executed, false);
  assert.equal(result.run.activation, null);
  assert.equal(result.run.execution, null);
  assert.match(result.run.recommendation.abstainReason, /no applicable skill/);
  assert.ok(Array.isArray(result.run.candidates));
  assert.equal(executorCalls, 0);
  await assert.rejects(
    chooseRun({ config: f.config, runId: result.run.runId, skills: ['fixture:calculate'] }),
    /not pending|no_match|terminal/i,
  );
});

test('owner choose executes only the selected skill and records verification separately', async (t) => {
  const f = await fixture(t);
  const prepared = await prepareTask({ config: f.config, task: '计算 6*7', selector: f.selector });
  const chosen = await chooseRun({
    config: f.config,
    runId: prepared.run.runId,
    skills: ['fixture:calculate'],
    decisionToken: prepared.run.planHash,
  });
  assert.equal(chosen.status, 'executed');
  assert.equal(chosen.states.executed, true);
  assert.equal(chosen.states.independentlyVerified, false);
  assert.equal(JSON.parse(chosen.execution.steps[0].stdout).actual, 42);
  const verified = await verifyRun({
    config: f.config,
    runId: chosen.runId,
    verified: true,
    details: { checked: 'fixture output equals 42' },
  });
  assert.equal(verified.states.independentlyVerified, true);
  assert.equal(verified.status, 'verified');
});

test('skip never loads a body or calls the host executor', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const prepared = await prepareTask({ config: f.config, task: '计算 6*7', selector: f.selector });
  const skipped = await chooseRun({
    config: f.config,
    runId: prepared.run.runId,
    skip: true,
    executor: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.states.activated, false);
  assert.equal(calls, 0);
});

test('route-only intent persists across handoff and cannot be widened by choose', async (t) => {
  const f = await fixture(t);
  const prepared = await prepareTask({
    config: f.config,
    task: '计算 6*7',
    selector: f.selector,
    intent: 'route',
  });
  assert.equal(prepared.run.intent, 'route');
  const chosen = await chooseRun({
    config: f.config,
    runId: prepared.run.runId,
    skills: ['fixture:calculate'],
    decisionToken: prepared.run.planHash,
  });
  assert.equal(chosen.states.activated, true);
  assert.equal(chosen.states.executed, false);
});

test('forged, unknown and stale decisions are rejected', async (t) => {
  const f = await fixture(t);
  const prepared = await prepareTask({ config: f.config, task: '计算 6*7', selector: f.selector });
  await assert.rejects(
    chooseRun({
      config: f.config,
      runId: prepared.run.runId,
      skills: ['fixture:not-a-candidate'],
      decisionToken: prepared.run.planHash,
    }),
    /not pending|unknown/i,
  );
  await assert.rejects(
    chooseRun({
      config: f.config,
      runId: prepared.run.runId,
      skills: ['fixture:calculate'],
      decisionToken: 'forged-token',
    }),
    /token|stale/i,
  );
  const script = path.join(f.dir, 'skills', 'calculate', 'scripts', 'run.mjs');
  await fs.writeFile(script, "process.stdout.write('changed');", 'utf8');
  await assert.rejects(
    chooseRun({
      config: f.config,
      runId: prepared.run.runId,
      skills: ['fixture:calculate'],
      decisionToken: prepared.run.planHash,
    }),
    /stale|changed/i,
  );
});

test('trust-policy changes after prepare invalidate the pending plan', async (t) => {
  const f = await fixture(t, { executionEnabled: false });
  const prepared = await prepareTask({ config: f.config, task: '计算 6*7', selector: f.selector });
  const { config: changed } = await makeConfig(f.dir, { skills: ['calculate'], executionEnabled: true });
  await assert.rejects(
    chooseRun({
      config: changed,
      runId: prepared.run.runId,
      skills: ['fixture:calculate'],
      decisionToken: prepared.run.planHash,
    }),
    /config|stale|policy/i,
  );
});

test('explicit auto runs a trusted script and does not self-certify verification', async (t) => {
  const f = await fixture(t, { auto: true });
  const result = await prepareTask({ config: f.config, task: '计算 6*7', selector: f.selector });
  assert.equal(result.pendingChoice, null);
  assert.equal(result.run.mode, 'auto');
  assert.equal(result.run.decision.decidedBy, 'auto-policy');
  assert.equal(result.run.states.executed, true);
  assert.equal(result.run.states.independentlyVerified, false);
  assert.equal(JSON.parse(result.run.execution.steps[0].stdout).actual, 42);
});

test('auto executes steps in mandatory dependency order', async (t) => {
  const dir = await makeTempDir(t, 'dag-exec');
  await writeSkill(dir, {
    name: 'data-step',
    triggers: ['数据', 'data'],
    script: "process.stdout.write('data-ran');",
  });
  await writeSkill(dir, {
    name: 'report-step',
    triggers: ['报告', 'report'],
    dependencies: ['data-step'],
    script: "process.stdout.write('report-ran');",
  });
  const { config } = await makeConfig(dir, { skills: ['data-step', 'report-step'], auto: true });
  const selector = async ({ candidates }) => ({
    selected: [{ id: candidates.find((candidate) => candidate.name === 'report-step').id, reason: 'fixture', confidence: 0.9 }],
  });
  const result = await prepareTask({ config, task: '生成报告', selector });
  assert.deepEqual(
    result.run.execution.steps.map((step) => step.skillId),
    ['fixture:data-step', 'fixture:report-step'],
  );
  assert.equal(result.run.status, 'executed');
});

test('stopOnError=false never executes a dependent after its prerequisite fails', async (t) => {
  const dir = await makeTempDir(t, 'blocked-dependent');
  await writeSkill(dir, {
    name: 'prerequisite',
    triggers: ['prerequisite', '前置计算'],
    script: 'process.exit(3);',
  });
  await writeSkill(dir, {
    name: 'dependent',
    triggers: ['dependent', '依赖报告'],
    dependencies: ['prerequisite'],
    script: "process.stdout.write('dependent must not run');",
  });
  const { config } = await makeConfig(dir, {
    skills: ['prerequisite', 'dependent'],
    auto: true,
    stopOnError: false,
  });
  const selector = async ({ candidates }) => ({
    selected: candidates.map((candidate) => ({
      id: candidate.id,
      reason: 'fixture dependency plan',
      confidence: 0.8,
    })),
  });
  const result = await prepareTask({ config, task: '前置计算 dependent 依赖报告', selector });
  const prerequisite = result.run.execution.steps.find((step) => step.skillId === 'fixture:prerequisite');
  const dependent = result.run.execution.steps.find((step) => step.skillId === 'fixture:dependent');
  assert.equal(prerequisite.status, 'failed');
  assert.ok(dependent, 'dependent step should be reported, not silently omitted');
  assert.equal(dependent.status, 'blocked');
  assert.notEqual(dependent.status, 'executed');
  assert.deepEqual(dependent.blockedBy, [prerequisite.stepId]);
  assert.equal(result.run.execution.counts.blocked, 1);
  assert.equal(result.run.status, 'execution_failed');
});

test('mixed actual execution and instruction handoff aggregates as partial', async (t) => {
  const dir = await makeTempDir(t, 'partial');
  await writeSkill(dir, {
    name: 'actual',
    triggers: ['actual', '真实执行'],
    script: "process.stdout.write('actual ran');",
  });
  await writeSkill(dir, {
    name: 'host-only',
    triggers: ['host-only', '宿主步骤'],
  });
  const { config } = await makeConfig(dir, {
    skills: ['actual', 'host-only'],
    auto: true,
    trusted: ['fixture:actual'],
  });
  const selector = async ({ candidates }) => ({
    selected: candidates.map((candidate) => ({
      id: candidate.id,
      reason: 'fixture composite task',
      confidence: 0.8,
    })),
  });
  const result = await prepareTask({ config, task: '真实执行 and 宿主步骤 host-only', selector });
  const statuses = new Set(result.run.execution.steps.map((step) => step.status));
  assert.ok(statuses.has('executed'));
  assert.ok(statuses.has('handoff'));
  assert.equal(result.run.execution.status, 'partial');
  assert.equal(result.run.status, 'partial');
  assert.equal(result.run.states.executed, true);
  assert.equal(result.run.states.handoff, true);
  assert.equal(result.run.states.partial, true);
  assert.equal(result.run.execution.counts.handoff, 1);
});

test('SDK rerouting uses a new phase/observation set and preserves explicit choices', async (t) => {
  const dir = await makeTempDir(t, 'reroute');
  await writeSkill(dir, { name: 'planner', triggers: ['计划'] });
  await writeSkill(dir, { name: 'reporter', triggers: ['报告'] });
  const { config } = await makeConfig(dir, { skills: ['planner', 'reporter'] });
  const selector = async ({ candidates, phase }) => {
    const wanted = phase === 'reporting' ? 'reporter' : 'planner';
    const picked = candidates.find((candidate) => candidate.name === wanted);
    return { selected: [{ id: picked.id, reason: `phase ${phase} fixture`, confidence: 0.8 }] };
  };
  const first = await prepareTask({ config, task: '继续工作', phase: 'planning', selector });
  const second = await prepareTask({
    config,
    task: '继续工作',
    phase: 'reporting',
    observations: ['CSV 统计已完成'],
    selector,
  });
  assert.deepEqual(first.run.recommendation.selected.map((entry) => entry.id), ['fixture:planner']);
  assert.deepEqual(second.run.recommendation.selected.map((entry) => entry.id), ['fixture:reporter']);
  assert.notEqual(first.run.runId, second.run.runId);
  assert.equal(second.run.phase, 'reporting');
});

test('trusted script timeout actually terminates the child and reports partial status', async (t) => {
  const dir = await makeTempDir(t, 'timeout');
  await writeSkill(dir, {
    name: 'hang',
    triggers: ['hang'],
    script: "process.stdout.write('started'); setInterval(() => {}, 1000);",
  });
  const { config } = await makeConfig(dir, { skills: ['hang'], auto: true, timeoutMs: 700 });
  const selector = async ({ candidates }) => ({
    selected: [{ id: candidates[0].id, reason: 'fixture timeout', confidence: 0.9 }],
  });
  const started = Date.now();
  const result = await prepareTask({ config, task: 'hang', selector });
  const elapsed = Date.now() - started;
  assert.equal(result.run.execution.steps[0].status, 'timeout');
  assert.equal(result.run.execution.steps[0].timedOut, true);
  assert.ok(elapsed < 15000, `timeout cleanup took too long: ${elapsed}ms`);
});

test('nonzero script exit and untrusted scripts do not report execution success', async (t) => {
  const dir = await makeTempDir(t, 'exit');
  await writeSkill(dir, {
    name: 'broken',
    triggers: ['broken'],
    script: "process.stderr.write('boom'); process.exit(3);",
  });
  const { config } = await makeConfig(dir, { skills: ['broken'], auto: true, trusted: [] });
  const selector = async ({ candidates }) => ({
    selected: [{ id: candidates[0].id, reason: 'fixture', confidence: 0.9 }],
  });
  const result = await prepareTask({ config, task: 'broken', selector });
  assert.equal(result.run.states.executed, false);
  assert.equal(result.run.execution.steps[0].status, 'handoff');
  assert.match(result.run.execution.steps[0].reason, /trustedSkillIds/);

  const { config: trustedConfig } = await makeConfig(dir, { skills: ['broken'], auto: true });
  const failed = await prepareTask({ config: trustedConfig, task: 'broken', selector });
  assert.equal(failed.run.status, 'execution_failed');
  assert.equal(failed.run.execution.steps[0].status, 'failed');
  assert.equal(failed.run.execution.steps[0].exitCode, 3);
  assert.match(failed.run.execution.steps[0].stderr, /boom/);
});
