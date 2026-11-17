import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {
  loadTaskSession,
  saveTaskSession,
  classifyTask,
} from '../src/adaptive.mjs';
import { loadConfig } from '../src/config.mjs';
import { chooseRun, prepareTask, resumeRun, withPolicyMode } from '../src/router.mjs';
import { makeTempDir, makeConfig, writeSkill, writeConfigFile, projectRoot } from './helpers.mjs';

const bin = path.join(projectRoot, 'bin', 'skill-conductor.mjs');

function runNode(args, { cwd = projectRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function mcpClient(configPath) {
  const child = spawn(process.execPath, [bin, 'mcp', '--config', configPath], {
    cwd: projectRoot,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = '';
  let nextId = 1;
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  rl.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    }
  });
  const closed = new Promise((resolve) => child.on('close', resolve));
  return {
    get stderr() {
      return stderr;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    request(method, params) {
      const id = nextId;
      nextId += 1;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`,
      );
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}; stderr=${stderr}`));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
      });
    },
    async close() {
      child.stdin.end();
      await closed;
    },
  };
}

async function adaptiveFixture(t, options = {}) {
  const dir = await makeTempDir(t, 'adaptive');
  await writeSkill(dir, {
    name: 'calculate',
    triggers: ['calculate', '计算', '报告', 'CSV'],
    script: "process.stdout.write(JSON.stringify({actual:42}));",
  });
  if (options.extraSkills) {
    for (const skill of options.extraSkills) await writeSkill(dir, skill);
  }
  const names = ['calculate', ...(options.extraSkills ?? []).map((skill) => skill.name)];
  const { config, raw } = await makeConfig(dir, {
    skills: names,
    ...options,
  });
  const counter = { selectors: 0, executors: 0 };
  const selector = async ({ candidates }) => {
    counter.selectors += 1;
    const picked = options.pick ? options.pick(candidates) : candidates[0];
    if (!picked) return { selected: [], abstainReason: options.abstainReason ?? 'fixture found no usable skill' };
    return {
      selected: [{ id: picked.id, reason: 'synthetic callback fixture, not live semantic accuracy', confidence: 0.9 }],
    };
  };
  const executor = async () => {
    counter.executors += 1;
    return { ok: true, output: 'host executor fixture' };
  };
  return { dir, config, raw, counter, selector, executor };
}

test('OFF short-circuits before materials/catalog/selector/executor and blocks pending choose/resume', async (t) => {
  const enabled = await adaptiveFixture(t);
  const pending = await prepareTask({
    config: enabled.config,
    task: '请计算 6*7',
    taskId: 'task-off',
    selector: enabled.selector,
  });
  assert.equal(pending.run.status, 'awaiting_choice');

  const disabled = await makeConfig(enabled.dir, {
    skills: ['calculate'],
    assistance: { enabled: false, profile: 'balanced' },
  });
  const missing = path.join(enabled.dir, 'missing-material.txt');
  const off = await prepareTask({
    config: disabled.config,
    task: '请处理这个文件并生成报告',
    files: [missing],
    taskId: 'task-off-2',
    selector: enabled.selector,
    executor: enabled.executor,
    intent: 'run',
  });
  assert.equal(off.run.status, 'disabled');
  assert.equal(off.pendingChoice, null);
  assert.equal(off.run.adaptive.trigger.reasonCode, 'disabled_total_switch');
  assert.notEqual(off.run.status, 'no_match');
  assert.deepEqual(off.run.materials, []);
  assert.deepEqual(off.run.materialErrors, []);
  assert.equal(enabled.counter.selectors, 1, 'only the enabled preparation may call the selector');
  assert.equal(enabled.counter.executors, 0);
  await assert.rejects(
    chooseRun({ config: disabled.config, runId: pending.run.runId, skills: ['fixture:calculate'] }),
    /disabled/i,
  );
  await assert.rejects(resumeRun({ config: disabled.config, runId: pending.run.runId }), /disabled/i);
  await assert.rejects(
    prepareTask({
      config: disabled.config,
      task: 'manual please',
      taskId: 'task-off-manual',
      event: 'manual_request',
      selector: enabled.selector,
    }).then((result) => {
      assert.equal(result.run.status, 'disabled');
      throw new Error('manual must not override total off');
    }),
    /manual must not override total off/,
  );
});

test('manual ignores passive events, explicit manual works, and OFF still wins', async (t) => {
  const f = await adaptiveFixture(t, { assistance: { enabled: true, profile: 'manual' } });
  const passive = await prepareTask({
    config: f.config,
    task: '请分析 CSV 并生成报告',
    taskId: 'manual-task',
    event: 'phase_change',
    selector: f.selector,
  });
  assert.equal(passive.run.status, 'suppressed');
  assert.equal(passive.run.adaptive.trigger.reasonCode, 'manual_profile_passive');
  assert.equal(f.counter.selectors, 0);

  const manual = await prepareTask({
    config: f.config,
    task: '请分析 CSV 并生成报告',
    taskId: 'manual-task',
    event: 'manual_request',
    selector: f.selector,
  });
  assert.equal(manual.run.status, 'awaiting_choice');
  assert.equal(manual.run.adaptive.trigger.reasonCode, 'manual_request');
  assert.equal(f.counter.selectors, 1);

  const legacy = await prepareTask({
    config: f.config,
    task: '计算 6*7',
    selector: f.selector,
  });
  assert.equal(legacy.run.status, 'suppressed');
  assert.equal(legacy.run.adaptive.trigger.reasonCode, 'manual_profile_passive');
  assert.equal(f.counter.selectors, 1);

  const off = await makeConfig(f.dir, {
    skills: ['calculate'],
    assistance: { enabled: false, profile: 'manual' },
  });
  const result = await prepareTask({
    config: off.config,
    task: '计算 6*7',
    taskId: 'manual-task',
    event: 'manual_request',
    selector: f.selector,
  });
  assert.equal(result.run.status, 'disabled');
});

test('balanced skips small talk and Chinese one-sentence edits, routes specialized Chinese + file, and documents ambiguous fallback', async (t) => {
  const f = await adaptiveFixture(t);
  const smallTalk = await prepareTask({
    config: f.config,
    task: '谢谢！',
    taskId: 'small-talk',
    selector: f.selector,
  });
  assert.equal(smallTalk.run.status, 'suppressed');
  assert.equal(smallTalk.run.adaptive.trigger.reasonCode, 'new_task_smalltalk_skip');
  assert.equal(f.counter.selectors, 0);

  const chineseEditWording = [
    '把这句话改通顺：我昨天去了学校。',
    '帮我把“天气好今天”改通顺。',
    '请把这句话改一下',
  ];
  for (const [index, wording] of chineseEditWording.entries()) {
    const chineseEdit = await prepareTask({
      config: f.config,
      task: wording,
      taskId: `chinese-edit-${index}`,
      selector: f.selector,
    });
    assert.equal(chineseEdit.run.status, 'suppressed', wording);
    assert.equal(chineseEdit.run.adaptive.trigger.reasonCode, 'new_task_simple_skip', wording);
    assert.equal(f.counter.selectors, 0);
    assert.equal(classifyTask(wording).kind, 'simple', wording);
  }

  const needsSkill = await prepareTask({
    config: f.config,
    task: 'Could you help with the next step?',
    taskId: 'needs-skill-hint',
    activity: { needsSkill: true },
    selector: f.selector,
  });
  assert.equal(needsSkill.run.status, 'awaiting_choice');
  assert.equal(needsSkill.run.adaptive.trigger.reasonCode, 'new_task_needs_skill');
  assert.equal(f.counter.selectors, 1);

  const specializedChineseEditLike = await prepareTask({
    config: f.config,
    task: '请把这份 CSV 数据整理一下并生成报告',
    taskId: 'specialized-even-with-edit-verb',
    selector: f.selector,
  });
  assert.equal(specializedChineseEditLike.run.status, 'awaiting_choice');
  assert.equal(specializedChineseEditLike.run.adaptive.trigger.reasonCode, 'new_task_specialized');
  assert.equal(f.counter.selectors, 2);

  const csv = path.join(f.dir, '销售 数据.csv');
  await fs.writeFile(csv, '月份,金额\n1,10\n', 'utf8');
  const specialized = await prepareTask({
    config: f.config,
    task: '请分析这份销售数据并生成报告',
    files: [csv],
    taskId: 'chinese-specialized',
    phase: 'reporting',
    selector: f.selector,
  });
  assert.equal(specialized.run.status, 'awaiting_choice');
  assert.equal(specialized.run.adaptive.trigger.reasonCode, 'new_task_specialized');
  assert.equal(f.counter.selectors, 3);

  const ambiguous = await prepareTask({
    config: f.config,
    task: 'Could you have a look at the thing we discussed?',
    taskId: 'english-ambiguous',
    selector: f.selector,
  });
  assert.equal(ambiguous.run.status, 'awaiting_choice');
  assert.equal(ambiguous.run.adaptive.trigger.reasonCode, 'new_task_ambiguous_cautious');
  assert.match(ambiguous.run.adaptive.trigger.explanation, /not English-only/i);
  assert.equal(f.counter.selectors, 4);
});

test('ten unchanged continuation calls reuse one pending choice; skip and no-match suppression do not re-query', async (t) => {
  const f = await adaptiveFixture(t);
  const first = await prepareTask({
    config: f.config,
    task: '请计算 6*7',
    taskId: 'pending-dedupe',
    selector: f.selector,
  });
  assert.equal(first.run.status, 'awaiting_choice');
  const runId = first.run.runId;
  for (let index = 0; index < 10; index += 1) {
    const again = await prepareTask({
      config: f.config,
      task: '请计算 6*7',
      taskId: 'pending-dedupe',
      event: 'routine_continuation',
      selector: f.selector,
    });
    assert.equal(again.run.runId, runId);
    assert.equal(again.pendingChoice.runId, runId);
    assert.equal(again.run.status, 'awaiting_choice');
  }
  assert.equal(f.counter.selectors, 1);
  const session = await loadTaskSession({ config: f.config, taskId: 'pending-dedupe' });
  assert.equal(session.counters.gateChecks, 11);
  assert.equal(session.counters.selectorCalls, 1);
  assert.equal(session.counters.ownerPrompts, 1);

  await chooseRun({ config: f.config, runId, skip: true, decidedBy: 'owner-test' });
  const skipped = await prepareTask({
    config: f.config,
    task: '请计算 6*7',
    taskId: 'pending-dedupe',
    event: 'routine_continuation',
    selector: f.selector,
  });
  assert.equal(skipped.run.status, 'suppressed');
  assert.equal(skipped.run.adaptive.trigger.reasonCode, 'owner_skipped_phase');
  assert.equal(f.counter.selectors, 1);

  const selector = async () => {
    f.counter.selectors += 1;
    return { selected: [], abstainReason: 'real no-match fixture' };
  };
  const noMatch = await prepareTask({
    config: f.config,
    task: '请计算 999',
    taskId: 'no-match-task',
    selector,
  });
  assert.equal(noMatch.run.status, 'no_match');
  const selectorsAfterNoMatch = f.counter.selectors;
  for (let index = 0; index < 10; index += 1) {
    const again = await prepareTask({
      config: f.config,
      task: '请计算 999',
      taskId: 'no-match-task',
      event: 'routine_continuation',
      selector,
    });
    assert.equal(again.run.status, 'suppressed');
    assert.equal(again.run.adaptive.trigger.reasonCode, 'no_match_suppressed');
  }
  assert.equal(f.counter.selectors, selectorsAfterNoMatch, 'no-match suppression must not call the selector again');
});

test('phase, material-family and requirements changes reroute; same-format input reuses context without execution', async (t) => {
  const dir = await makeTempDir(t, 'reroute-adaptive');
  await writeSkill(dir, { name: 'planner', triggers: ['计划', 'plan'] });
  await writeSkill(dir, { name: 'reporter', triggers: ['报告', 'report'] });
  const { config } = await makeConfig(dir, { skills: ['planner', 'reporter'], auto: true });
  let selectors = 0;
  const selector = async ({ phase }) => {
    selectors += 1;
    return {
      selected: [
        {
          id: phase === 'reporting' ? 'fixture:reporter' : 'fixture:planner',
          reason: 'synthetic phase fixture',
          confidence: 0.8,
        },
      ],
    };
  };
  const firstCsv = path.join(dir, 'a.csv');
  const secondCsv = path.join(dir, 'b.csv');
  await fs.writeFile(firstCsv, 'a,b\n1,2\n', 'utf8');
  await fs.writeFile(secondCsv, 'a,b\n3,4\n', 'utf8');

  const first = await prepareTask({
    config,
    task: '请继续处理 CSV 并生成报告',
    files: [firstCsv],
    phase: 'planning',
    taskId: 'reroute-task',
    selector,
  });
  assert.equal(first.run.status, 'activated');
  assert.ok(first.run.context);
  assert.equal(selectors, 1);

  const routine = await prepareTask({
    config,
    task: '请继续处理 CSV 并生成报告',
    files: [firstCsv],
    phase: 'planning',
    taskId: 'reroute-task',
    event: 'routine_continuation',
    selector,
  });
  assert.equal(routine.run.status, 'reused');
  assert.equal(routine.run.reused, true);
  assert.equal(routine.run.executedForThisEvent, false);
  assert.equal(routine.run.states.reused, true);
  assert.equal(routine.run.states.executed, false);
  assert.equal(routine.run.execution.status, 'not_executed');
  assert.equal(routine.run.sourceRunId, first.run.runId);
  assert.ok(routine.run.context.skills.length > 0);
  assert.equal(selectors, 1);

  const sameFormat = await prepareTask({
    config,
    task: '请继续处理 CSV 并生成报告',
    files: [secondCsv],
    phase: 'planning',
    taskId: 'reroute-task',
    event: 'routine_continuation',
    selector,
  });
  assert.equal(sameFormat.run.status, 'reused');
  assert.equal(sameFormat.run.states.executed, false);
  assert.match(sameFormat.run.instruction, /no selector|actual work|executed/i);
  assert.equal(selectors, 1);

  const phase = await prepareTask({
    config,
    task: '请继续处理 CSV 并生成报告',
    files: [secondCsv],
    phase: 'reporting',
    taskId: 'reroute-task',
    event: 'phase_change',
    selector,
  });
  assert.equal(phase.run.status, 'activated');
  assert.equal(phase.run.phase, 'reporting');
  assert.equal(selectors, 2);

  const material = path.join(dir, 'notes.md');
  await fs.writeFile(material, '# notes\n', 'utf8');
  const changedMaterial = await prepareTask({
    config,
    task: '请继续处理材料',
    files: [material],
    phase: 'reporting',
    taskId: 'reroute-task',
    event: 'material_family_change',
    selector,
  });
  assert.equal(changedMaterial.run.status, 'activated');
  assert.equal(selectors, 3);

  const changedRequirements = await prepareTask({
    config,
    task: '请继续处理材料',
    files: [material],
    phase: 'reporting',
    taskId: 'reroute-task',
    event: 'requirements_change',
    activity: { requirementsKey: 'requirements-v2' },
    selector,
  });
  assert.equal(changedRequirements.run.status, 'activated');
  assert.equal(selectors, 4);
});

test('failure threshold defaults to two, dedupes the same fingerprint, and resets for a new task', async (t) => {
  const f = await adaptiveFixture(t);
  const runFailure = (taskId, errorFingerprint) =>
    prepareTask({
      config: f.config,
      task: '请计算 6*7',
      taskId,
      event: 'repeated_failure',
      activity: { errorFingerprint },
      selector: f.selector,
    });
  const first = await runFailure('failure-task', 'same-error');
  assert.equal(first.run.status, 'suppressed');
  assert.equal(first.run.adaptive.trigger.reasonCode, 'repeated_failure_threshold');
  assert.equal(f.counter.selectors, 0);
  const second = await runFailure('failure-task', 'same-error');
  assert.equal(second.run.status, 'awaiting_choice');
  assert.equal(second.run.adaptive.trigger.reasonCode, 'repeated_failure_threshold_reached');
  assert.equal(f.counter.selectors, 1);
  const third = await runFailure('failure-task', 'same-error');
  assert.equal(third.run.status, 'suppressed');
  assert.equal(third.run.adaptive.trigger.reasonCode, 'repeated_failure_deduped');
  assert.equal(f.counter.selectors, 1);

  const isolated = await runFailure('other-task', 'same-error');
  assert.equal(isolated.run.adaptive.trigger.reasonCode, 'repeated_failure_threshold', 'a new task cannot inherit failure counts');
});

test('task state is scoped by workspace + sessionId + taskId; a second session gets a fresh check', async (t) => {
  const f = await adaptiveFixture(t, {
    assistance: {
      enabled: true,
      profile: 'custom',
      triggers: { newTask: true, ambiguousNewTask: true, phaseChange: true },
      budget: { maxAutomaticChecksPerTask: 1 },
    },
  });
  const first = await prepareTask({
    config: f.config,
    task: '请分析这份 CSV 数据并生成报告',
    taskId: 'same-task',
    sessionId: 'session-one',
    selector: f.selector,
  });
  assert.equal(first.run.status, 'awaiting_choice');
  await chooseRun({
    config: f.config,
    runId: first.run.runId,
    skip: true,
    decidedBy: 'owner-test',
  });
  const suppressed = await prepareTask({
    config: f.config,
    task: '请分析这份 CSV 数据并生成报告',
    taskId: 'same-task',
    sessionId: 'session-one',
    event: 'routine_continuation',
    selector: f.selector,
  });
  assert.equal(suppressed.run.status, 'suppressed');
  assert.equal(suppressed.run.adaptive.trigger.reasonCode, 'owner_skipped_phase');

  const secondSession = await prepareTask({
    config: f.config,
    task: '请分析这份 CSV 数据并生成报告',
    taskId: 'same-task',
    sessionId: 'session-two',
    selector: f.selector,
  });
  assert.equal(secondSession.run.status, 'awaiting_choice');
  assert.notEqual(secondSession.run.runId, first.run.runId);
  assert.equal(secondSession.run.adaptive.trigger.reasonCode, 'new_task_specialized');
  assert.equal(f.counter.selectors, 2, 'the second session must not inherit the first session budget or pending state');

  const sessionOne = await loadTaskSession({
    config: f.config,
    taskId: 'same-task',
    sessionId: 'session-one',
  });
  const sessionTwo = await loadTaskSession({
    config: f.config,
    taskId: 'same-task',
    sessionId: 'session-two',
  });
  assert.notEqual(sessionOne.taskKey, sessionTwo.taskKey);
  assert.deepEqual(Object.keys(sessionOne.skippedPhases), ['(no phase)']);
  assert.deepEqual(sessionTwo.skippedPhases, {});
});

test('the same taskId in a different workspace does not inherit no-match or skip state', async (t) => {
  const first = await adaptiveFixture(t);
  const noMatchSelector = async () => {
    first.counter.selectors += 1;
    return { selected: [], abstainReason: 'workspace A no-match' };
  };
  const noMatch = await prepareTask({
    config: first.config,
    task: '请计算 6*7',
    taskId: 'shared-task-id',
    selector: noMatchSelector,
  });
  assert.equal(noMatch.run.status, 'no_match');

  const second = await adaptiveFixture(t);
  const secondResult = await prepareTask({
    config: second.config,
    task: '请分析这份 CSV 数据并生成报告',
    taskId: 'shared-task-id',
    selector: second.selector,
  });
  assert.equal(secondResult.run.status, 'awaiting_choice');
  assert.equal(secondResult.run.adaptive.trigger.reasonCode, 'new_task_specialized');
  assert.equal(second.counter.selectors, 1);
});

test('budget exhaustion is explicit and manual requests bypass it', async (t) => {
  const f = await adaptiveFixture(t, {
    assistance: {
      enabled: true,
      profile: 'custom',
      triggers: { newTask: true, ambiguousNewTask: true, phaseChange: true },
      budget: { maxAutomaticChecksPerTask: 1 },
    },
  });
  const first = await prepareTask({
    config: f.config,
    task: '请分析 CSV 并生成报告',
    taskId: 'budget-task',
    phase: 'one',
    selector: f.selector,
  });
  assert.equal(first.run.status, 'awaiting_choice');
  assert.equal(f.counter.selectors, 1);

  const exhausted = await prepareTask({
    config: f.config,
    task: '请分析 CSV 并生成报告',
    taskId: 'budget-task',
    phase: 'two',
    event: 'phase_change',
    selector: f.selector,
  });
  assert.equal(exhausted.run.status, 'suppressed');
  assert.equal(exhausted.run.adaptive.trigger.reasonCode, 'budget_exhausted');
  assert.equal(exhausted.run.adaptive.trigger.budget.exhausted, true);
  assert.notEqual(exhausted.run.status, 'no_match');
  assert.equal(f.counter.selectors, 1);

  const manual = await prepareTask({
    config: f.config,
    task: '请分析 CSV 并生成报告',
    taskId: 'budget-task',
    phase: 'two',
    event: 'manual_request',
    selector: f.selector,
  });
  assert.equal(manual.run.status, 'awaiting_choice');
  assert.equal(manual.run.adaptive.trigger.reasonCode, 'manual_request');
  assert.equal(f.counter.selectors, 2);
});

test('cache invalidates on skill/script/config/catalog changes before reuse or activation', async (t) => {
  const f = await adaptiveFixture(t);
  const prepared = await prepareTask({
    config: f.config,
    task: '请计算 6*7',
    taskId: 'cache-task',
    selector: f.selector,
  });
  const chosen = await chooseRun({
    config: f.config,
    runId: prepared.run.runId,
    skills: ['fixture:calculate'],
    decidedBy: 'owner-test',
    executor: f.executor,
  });
  assert.equal(chosen.states.executed, true);
  assert.equal(chosen.execution.steps[0].status, 'executed');

  const reused = await prepareTask({
    config: f.config,
    task: '请计算 6*7',
    taskId: 'cache-task',
    event: 'routine_continuation',
    selector: f.selector,
  });
  assert.equal(reused.run.status, 'reused');
  assert.equal(reused.run.states.executed, false);
  const reuseSession = await loadTaskSession({ config: f.config, taskId: 'cache-task' });
  assert.equal(reuseSession.counters.executions, 1);
  assert.equal(reuseSession.counters.cacheReuse, 1);

  const skillFile = path.join(f.dir, 'skills', 'calculate', 'SKILL.md');
  await fs.writeFile(skillFile, '---\nname: calculate\ndescription: "changed"\n---\n\nChanged body.\n', 'utf8');
  const changedSkill = await prepareTask({
    config: f.config,
    task: '请计算 6*7',
    taskId: 'cache-task',
    event: 'routine_continuation',
    selector: f.selector,
  });
  assert.equal(changedSkill.run.status, 'awaiting_choice');
  assert.equal(changedSkill.run.adaptive.trigger.reasonCode, 'cache_invalidated_skill');
  assert.equal(f.counter.selectors, 2, 'invalidation must perform a real new check, not silently reuse');
  await chooseRun({
    config: f.config,
    runId: changedSkill.run.runId,
    skills: ['fixture:calculate'],
    decidedBy: 'owner-test',
    executor: f.executor,
  });

  const scriptFile = path.join(f.dir, 'skills', 'calculate', 'scripts', 'run.mjs');
  await fs.writeFile(scriptFile, "process.stdout.write(JSON.stringify({actual:99}));", 'utf8');
  const changedScript = await prepareTask({
    config: f.config,
    task: '请计算 6*7',
    taskId: 'cache-task',
    event: 'routine_continuation',
    selector: f.selector,
  });
  assert.equal(changedScript.run.adaptive.trigger.reasonCode, 'cache_invalidated_script');
  await chooseRun({
    config: f.config,
    runId: changedScript.run.runId,
    skills: ['fixture:calculate'],
    decidedBy: 'owner-test',
    executor: f.executor,
  });

  await writeSkill(f.dir, { name: 'new-catalog-entry', triggers: ['new'] });
  const changedCatalog = await prepareTask({
    config: f.config,
    task: '请计算 6*7',
    taskId: 'cache-task',
    event: 'routine_continuation',
    selector: f.selector,
  });
  assert.equal(changedCatalog.run.adaptive.trigger.reasonCode, 'cache_invalidated_catalog');
  await chooseRun({
    config: f.config,
    runId: changedCatalog.run.runId,
    skills: ['fixture:calculate'],
    decidedBy: 'owner-test',
    executor: f.executor,
  });

  const changedConfig = await makeConfig(f.dir, {
    skills: ['calculate'],
    assistance: { enabled: true, profile: 'proactive' },
  });
  const configInvalidated = await prepareTask({
    config: changedConfig.config,
    task: '请计算 6*7',
    taskId: 'cache-task',
    event: 'routine_continuation',
    selector: f.selector,
  });
  assert.equal(configInvalidated.run.adaptive.trigger.reasonCode, 'cache_invalidated_config');
  await assert.rejects(
    chooseRun({ config: changedConfig.config, runId: prepared.run.runId, skills: ['fixture:calculate'] }),
    /stale|config|already/i,
  );
});

test('CLI settings show/update assistance independently and malformed updates never partially write', async (t) => {
  const f = await adaptiveFixture(t);
  const configPath = await writeConfigFile(f.dir, {
    ...f.raw,
    'x-owner-extension': { keep: true },
  });
  const shown = await runNode(['settings', 'show', '--config', configPath]);
  assert.equal(shown.code, 0, shown.stderr);
  const before = JSON.parse(shown.stdout);
  assert.equal(before.assistance.enabled, true);
  assert.equal(before.assistance.profile, 'balanced');
  assert.equal(before.policy.mode, 'ask');

  const cliSmallTalk = await runNode([
    'route',
    '谢谢',
    '--task-id',
    'cli-adaptive-task',
    '--config',
    configPath,
  ]);
  assert.equal(cliSmallTalk.code, 0, cliSmallTalk.stderr);
  const cliSuppressed = JSON.parse(cliSmallTalk.stdout);
  assert.equal(cliSuppressed.status, 'suppressed');
  assert.equal(cliSuppressed.trigger.reasonCode, 'new_task_smalltalk_skip');

  const cliManual = await runNode([
    'route',
    '请计算 6*7',
    '--task-id',
    'cli-adaptive-task',
    '--event',
    'manual_request',
    '--config',
    configPath,
  ]);
  assert.equal(cliManual.code, 0, cliManual.stderr);
  assert.equal(JSON.parse(cliManual.stdout).trigger.reasonCode, 'manual_request');

  const disabled = await runNode(['settings', 'set', 'assistance.enabled', 'false', '--config', configPath]);
  assert.equal(disabled.code, 0, disabled.stderr);
  const afterDisable = JSON.parse(disabled.stdout);
  assert.equal(afterDisable.assistance.enabled, false);
  assert.equal(afterDisable.policy.mode, 'ask', 'assistance switch must not change ask/auto policy');

  const profile = await runNode(['settings', 'set', 'assistance.profile', 'conservative', '--config', configPath]);
  assert.equal(profile.code, 0, profile.stderr);
  const afterProfile = JSON.parse(profile.stdout);
  assert.equal(afterProfile.assistance.profile, 'conservative');
  assert.equal(afterProfile.assistance.enabled, false);
  const rawAfter = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(rawAfter['x-owner-extension'], { keep: true });
  assert.equal(rawAfter.policy.mode, 'ask');

  const beforeBad = await fs.readFile(configPath, 'utf8');
  const bad = await runNode(['settings', 'set', 'assistance.triggers.failureThreshold', 'not-a-number', '--config', configPath]);
  assert.notEqual(bad.code, 0);
  assert.equal(await fs.readFile(configPath, 'utf8'), beforeBad, 'a malformed setting must not partially overwrite config');
  const unknown = await runNode(['settings', 'set', 'assistance.magic', 'true', '--config', configPath]);
  assert.notEqual(unknown.code, 0);
  assert.equal(await fs.readFile(configPath, 'utf8'), beforeBad);

  const loaded = await loadConfig(configPath);
  assert.equal(loaded.assistance.enabled, false);
  assert.equal(loaded.assistance.profile, 'conservative');
  assert.equal(loaded.policy.mode, 'ask');
});

test('withPolicyMode retains assistance and cannot re-enable a disabled switch', async (t) => {
  const f = await adaptiveFixture(t);
  const switched = await withPolicyMode(f.config, 'auto');
  assert.equal(switched.policy.mode, 'auto');
  assert.equal(switched.assistance.enabled, true);
  assert.equal(switched.assistance.profile, 'balanced');

  const disabled = await makeConfig(f.dir, {
    skills: ['calculate'],
    assistance: { enabled: false, profile: 'manual' },
  });
  const stillDisabled = await withPolicyMode(disabled.config, 'auto');
  assert.equal(stillDisabled.policy.mode, 'auto');
  assert.equal(stillDisabled.assistance.enabled, false);
  assert.equal(stillDisabled.assistance.profile, 'manual');
});

test('a stale pending pointer is refreshed: completed context is reused and a skip stays suppressed', async (t) => {
  const f = await adaptiveFixture(t);
  const completed = await prepareTask({
    config: f.config,
    task: '请计算 6*7',
    taskId: 'stale-pending-completed',
    selector: f.selector,
  });
  await chooseRun({
    config: f.config,
    runId: completed.run.runId,
    skills: ['fixture:calculate'],
    decidedBy: 'owner-test',
  });
  let session = await loadTaskSession({ config: f.config, taskId: 'stale-pending-completed' });
  session.pending = {
    runId: completed.run.runId,
    fingerprint: completed.run.adaptive.fingerprint,
    planHash: completed.run.planHash,
    phase: null,
    at: new Date().toISOString(),
  };
  await saveTaskSession({ config: f.config, session });
  const selectors = f.counter.selectors;
  const refreshed = await prepareTask({
    config: f.config,
    task: '请计算 6*7',
    taskId: 'stale-pending-completed',
    event: 'routine_continuation',
    selector: f.selector,
  });
  assert.equal(refreshed.run.status, 'reused');
  assert.equal(refreshed.run.sourceRunId, completed.run.runId);
  assert.equal(refreshed.run.executedForThisEvent, false);
  assert.equal(f.counter.selectors, selectors);

  const skipped = await prepareTask({
    config: f.config,
    task: '请计算 7*7',
    taskId: 'stale-pending-skipped',
    selector: f.selector,
  });
  await chooseRun({
    config: f.config,
    runId: skipped.run.runId,
    skip: true,
    decidedBy: 'owner-test',
  });
  session = await loadTaskSession({ config: f.config, taskId: 'stale-pending-skipped' });
  session.pending = {
    runId: skipped.run.runId,
    fingerprint: skipped.run.adaptive.fingerprint,
    planHash: skipped.run.planHash,
    phase: null,
    at: new Date().toISOString(),
  };
  await saveTaskSession({ config: f.config, session });
  const suppressed = await prepareTask({
    config: f.config,
    task: '请计算 7*7',
    taskId: 'stale-pending-skipped',
    event: 'routine_continuation',
    selector: f.selector,
  });
  assert.equal(suppressed.run.status, 'suppressed');
  assert.equal(suppressed.run.adaptive.trigger.reasonCode, 'owner_skipped_phase');
});

test('public adaptive event sequence reports real selector-call counters', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'examples', 'adaptive-event-sequence.mjs')], {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`example failed (${code}): ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
  assert.equal(result.events, 12);
  assert.equal(result.naivePerStepBaseline.selectorCalls, 12);
  assert.equal(result.adaptive.selectorCalls, 2);
  assert.equal(result.adaptive.cacheReuse, 10);
  assert.equal(result.selectorCallsAvoided, 10);
  assert.match(result.label, /synthetic/i);
});

test('CLI profile changes apply the chosen preset from fresh init and preserve explicit advanced overrides', async (t) => {
  const dir = await makeTempDir(t, 'profile-preset');
  const initialized = await runNode(['init', '--demo'], { cwd: dir });
  assert.equal(initialized.code, 0, initialized.stderr);
  const configPath = path.join(dir, '.skill-conductor', 'config.json');
  const rawInit = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(rawInit.assistance.profile, 'balanced');
  assert.equal(rawInit.assistance.triggers, undefined, 'init must not pin generated profile defaults');
  assert.equal(rawInit.assistance.budget, undefined, 'init must not pin generated budget defaults');

  const proactive = await runNode(['settings', 'set', 'assistance.profile', 'proactive', '--config', configPath]);
  assert.equal(proactive.code, 0, proactive.stderr);
  const proactiveConfig = JSON.parse(proactive.stdout);
  assert.equal(proactiveConfig.assistance.profile, 'proactive');
  assert.equal(proactiveConfig.assistance.triggers.deliveryRecheck, true);
  assert.equal(proactiveConfig.assistance.budget.maxAutomaticChecksPerTask, 24);
  assert.equal(proactiveConfig.policy.mode, 'ask');

  const balanced = await runNode(['settings', 'set', 'assistance.profile', 'balanced', '--config', configPath]);
  assert.equal(balanced.code, 0, balanced.stderr);
  const balancedConfig = JSON.parse(balanced.stdout);
  assert.equal(balancedConfig.assistance.triggers.deliveryRecheck, false);
  assert.equal(balancedConfig.assistance.budget.maxAutomaticChecksPerTask, 12);
  assert.equal(balancedConfig.policy.mode, 'ask');

  const custom = await runNode([
    'settings',
    'set',
    'assistance.budget.maxAutomaticChecksPerTask',
    '5',
    '--config',
    configPath,
  ]);
  assert.equal(custom.code, 0, custom.stderr);
  const backToBalanced = await runNode(['settings', 'set', 'assistance.profile', 'balanced', '--config', configPath]);
  assert.equal(backToBalanced.code, 0, backToBalanced.stderr);
  assert.equal(JSON.parse(backToBalanced.stdout).assistance.budget.maxAutomaticChecksPerTask, 5);
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).policy.mode, 'ask');
});

test('MCP hot-reloads the owner switch, handles events, and rejects settings mutation', async (t) => {
  const f = await adaptiveFixture(t);
  const configPath = await writeConfigFile(f.dir, f.raw);
  const client = mcpClient(configPath);
  try {
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'adaptive-test', version: '0' },
    });
    assert.equal(init.result.serverInfo.version, '0.2.0');
    client.notify('notifications/initialized', {});

    const list = await client.request('tools/list', {});
    const names = list.result.tools.map((tool) => tool.name);
    assert.ok(!names.some((name) => /setting|approve|decide|auto/i.test(name)), names.join(','));

    const smallTalk = await client.request('tools/call', {
      name: 'prepare_skills',
      arguments: { task: '谢谢', taskId: 'mcp-task' },
    });
    const suppressed = JSON.parse(smallTalk.result.content[0].text);
    assert.equal(suppressed.status, 'suppressed');
    assert.equal(suppressed.trigger.reasonCode, 'new_task_smalltalk_skip');

    const manual = await client.request('tools/call', {
      name: 'prepare_skills',
      arguments: { task: '请计算 6*7', taskId: 'mcp-task', event: 'manual_request' },
    });
    const pending = JSON.parse(manual.result.content[0].text);
    assert.equal(pending.status, 'awaiting_choice');
    assert.equal(pending.trigger.reasonCode, 'manual_request');

    const mutation = await client.request('tools/call', {
      name: 'update_settings',
      arguments: { key: 'assistance.enabled', value: false },
    });
    assert.equal(mutation.error.code, -32602);

    const cli = await runNode(['settings', 'set', 'assistance.enabled', 'false', '--config', configPath]);
    assert.equal(cli.code, 0, cli.stderr);

    const afterDisable = await client.request('tools/call', {
      name: 'prepare_skills',
      arguments: { task: '请计算 6*7', taskId: 'mcp-task', event: 'manual_request' },
    });
    const disabled = JSON.parse(afterDisable.result.content[0].text);
    assert.equal(disabled.status, 'disabled');
    assert.notEqual(disabled.status, 'no_match');
    assert.equal(disabled.trigger.reasonCode, 'disabled_total_switch');

    const unsupported = await client.request('tools/call', {
      name: 'prepare_skills',
      arguments: {
        task: '请计算 6*7',
        taskId: 'mcp-task',
        mode: 'auto',
        assistance: { enabled: true },
      },
    });
    assert.equal(unsupported.result.isError, true);
    const unsupportedBody = JSON.parse(unsupported.result.content[0].text);
    assert.equal(unsupportedBody.error, 'unsupported_arguments');
    assert.deepEqual(unsupportedBody.unsupported.sort(), ['assistance', 'mode']);
    assert.equal(unsupportedBody.status, undefined, 'unsupported settings must not be reported as a benign disabled result');

    const badEvent = await client.request('tools/call', {
      name: 'prepare_skills',
      arguments: { task: '请计算 6*7', event: 'pretend_success' },
    });
    assert.equal(badEvent.result.isError, true);
    assert.equal(JSON.parse(badEvent.result.content[0].text).error, 'invalid_arguments');

    const activate = await client.request('tools/call', {
      name: 'activate_run',
      arguments: { runId: pending.runId },
    });
    assert.equal(activate.result.isError, true);
    assert.match(activate.result.content[0].text, /disabled/i);

    const read = await client.request('tools/call', {
      name: 'get_run',
      arguments: { runId: pending.runId },
    });
    assert.equal(read.result.isError, undefined);
    assert.equal(JSON.parse(read.result.content[0].text).runId, pending.runId);
  } finally {
    await client.close();
  }
});
