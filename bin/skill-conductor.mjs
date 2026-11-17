#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { discoverConfigPath, loadConfig, normalizeConfig } from '../src/config.mjs';
import { assistanceExplanation } from '../src/adaptive.mjs';
import { toErrorObject } from '../src/errors.mjs';
import { RunStore } from '../src/store.mjs';
import {
  chooseRun,
  getRun,
  listSkills,
  listRuns,
  prepareTask,
} from '../src/router.mjs';
import { startMcpServer } from '../src/mcp.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `Skill Conductor v0.2 — adaptive, host-neutral skill routing

Usage:
  skill-conductor help
  skill-conductor init [--root PATH | --demo]
  skill-conductor list [--config PATH]
  skill-conductor route TASK [--config PATH] [--material FILE ...] [--phase X] [--mode ask|auto]
  skill-conductor run TASK [--config PATH] [--material FILE ...] [--phase X] [--mode ask|auto]
     [--task-id ID] [--session-id ID] [--event EVENT] [--activity JSON] [--needs-skill] [--manual]
  skill-conductor choose RUN_ID [--config PATH] (--skills ID,ID | --skip) [--activate-only]
  skill-conductor show RUN_ID [--config PATH]
  skill-conductor runs [--config PATH]
  skill-conductor settings [show] [--config PATH]
  skill-conductor settings set KEY VALUE [--config PATH]
  skill-conductor interactive [--config PATH]
  skill-conductor mcp [--config PATH]
  skill-conductor demo [--config PATH]

Config discovery: without --config, installed commands look for
.skill-conductor/config.json (or skill-conductor.config.json) in the working
directory and then its parents. Explicit --config always takes precedence.
Run "skill-conductor init" to create a safe local config, or
"skill-conductor init --demo" to copy the bundled first-party demo fixtures
into the current directory. Existing files are never overwritten.

Default policy is ask: route/run return "awaiting_choice" when a skill is
applicable (and never load bodies or execute until an owner choice), or a
terminal "no_match" when the selector abstains. "route" activates
context only; "run" executes trusted scripts after approval. --mode auto / a
trusted config policy.mode=auto is an explicit one-run autonomous opt-in.

Interactive (TTY only) discovers or resumes a pending run, shows the ranked
recommendation and reasons, and accepts the recommendation, numbered one/many,
or skip. Empty input is never approval. Noninteractive scripts should use
route + choose.

Adaptive triggering: assistance.enabled is the owner total switch. Profiles are
manual, conservative, balanced, proactive or custom. Without --task-id/--event,
legacy one-shot behavior is kept (except the total switch and manual profile).
With --task-id the cheap gate may trigger, suppress, reuse or return the same
pending choice. Settings are owner-CLI only: use
"skill-conductor settings set assistance.profile conservative" and
"skill-conductor settings set assistance.enabled false". This is independent of
policy.mode ask/auto.

Windows launcher: skill-conductor.cmd (set SKILL_CONDUCTOR_NODE if node is not
on PATH). Output is JSON on stdout. Diagnostics and errors go to stderr.`;

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      root: { type: 'string' },
      demo: { type: 'boolean', default: false },
      material: { type: 'string', multiple: true },
      observe: { type: 'string', multiple: true },
      phase: { type: 'string' },
      mode: { type: 'string' },
      'task-id': { type: 'string' },
      'session-id': { type: 'string' },
      event: { type: 'string' },
      activity: { type: 'string' },
      'needs-skill': { type: 'boolean', default: false },
      manual: { type: 'boolean', default: false },
      skills: { type: 'string' },
      skip: { type: 'boolean', default: false },
      'activate-only': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  return { values, positionals };
}

async function requireConfig(values) {
  if (values.config) return loadConfig(values.config, { cwd: process.cwd() });
  const discovered = await discoverConfigPath(process.cwd());
  if (!discovered) {
    throw new Error(
      `no skill-conductor config found from ${process.cwd()} upward; run "skill-conductor init --demo" or pass --config PATH`,
    );
  }
  process.stderr.write(`using config: ${discovered}\n`);
  return loadConfig(discovered, { cwd: process.cwd() });
}

const DEMO_IDS = ['demo:csv-inspector', 'demo:markdown-report'];
const DEMO_DATA_NAME = '销售 数据.csv';

function portableConfigPath(cwd, target) {
  const relative = path.relative(cwd, target);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `./${relative.replaceAll('\\', '/')}`;
  }
  return target.replaceAll('\\', '/');
}

function baseSelector() {
  return {
    mode: 'lexical',
    maxCandidates: 20,
    minScore: 0.8,
    ambiguityGap: 0.12,
    semanticAllThreshold: 40,
    semanticPrefilterLimit: 30,
    maxSelection: 3,
    timeoutMs: 60000,
  };
}

async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function init(values) {
  const cwd = process.cwd();
  const targetDir = path.join(cwd, '.skill-conductor');
  const configPath = path.join(targetDir, 'config.json');
  if (await exists(configPath)) {
    throw new Error(`refusing to overwrite existing config: ${configPath}`);
  }
  const demoDir = path.join(targetDir, 'demo');
  if (values.demo && (await exists(demoDir))) {
    throw new Error(`refusing to overwrite existing demo directory: ${demoDir}`);
  }
  if (values.demo && values.root) throw new Error('use either --demo or --root, not both');

  let raw;
  let roots;
  if (values.demo) {
    const sourceSkills = path.join(packageRoot, 'skills');
    const sourceData = path.join(packageRoot, 'data', DEMO_DATA_NAME);
    if (!(await exists(sourceSkills)) || !(await exists(sourceData))) {
      throw new Error('bundled demo fixtures are missing from this installation');
    }
    await fs.mkdir(path.join(demoDir, 'data'), { recursive: true });
    await fs.cp(sourceSkills, path.join(demoDir, 'skills'), {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
    });
    await fs.copyFile(sourceData, path.join(demoDir, 'data', DEMO_DATA_NAME), fsConstants.COPYFILE_EXCL);
    raw = {
      roots: [{ path: './demo/skills', namespace: 'demo', trusted: true }],
      selector: baseSelector(),
      policy: { mode: 'ask' },
      capabilities: ['filesystem.read', 'filesystem.write'],
      assistance: {
        enabled: true,
        profile: 'balanced',
      },
      execution: {
        enabled: true,
        allowlist: DEMO_IDS,
        trustedSkillIds: DEMO_IDS,
        timeoutMs: 30000,
        maxOutputBytes: 65536,
        maxArtifacts: 20,
        maxResourceBytes: 262144,
        stopOnError: true,
        captureOutput: true,
        runDir: './runs',
      },
      materials: {
        maxFileBytes: 1048576,
        maxTotalBytes: 4194304,
        maxFiles: 16,
        allowRoots: ['./demo'],
      },
      mcp: { allowExecution: false, maxInputBytes: 1048576 },
    };
    roots = raw.roots;
  } else {
    const root = values.root
      ? path.resolve(cwd, values.root)
      : path.join(cwd, 'skills');
    if (values.root) {
      let stat;
      try {
        stat = await fs.stat(root);
      } catch {
        throw new Error(`--root does not exist: ${root}`);
      }
      if (!stat.isDirectory()) throw new Error(`--root is not a directory: ${root}`);
    } else {
      await fs.mkdir(root, { recursive: true });
    }
    // Paths in .skill-conductor/config.json resolve relative to that file's
    // directory, not the caller's cwd.
    const rootValue = portableConfigPath(targetDir, root);
    raw = {
      roots: [{ path: rootValue, namespace: 'local', trusted: false }],
      selector: baseSelector(),
      policy: { mode: 'ask' },
      capabilities: ['filesystem.read', 'filesystem.write'],
      assistance: {
        enabled: true,
        profile: 'balanced',
      },
      execution: {
        enabled: false,
        allowlist: [],
        trustedSkillIds: [],
        timeoutMs: 30000,
        maxOutputBytes: 65536,
        runDir: './runs',
      },
      materials: {
        maxFileBytes: 1048576,
        maxTotalBytes: 4194304,
        maxFiles: 16,
        allowRoots: ['..', rootValue],
      },
      mcp: { allowExecution: false, maxInputBytes: 1048576 },
    };
    roots = raw.roots;
  }

  await fs.mkdir(targetDir, { recursive: true });
  // "wx" is the no-overwrite guarantee even if another process raced us.
  await fs.writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  emit({
    initialized: true,
    demo: Boolean(values.demo),
    configPath,
    configSearch: '.skill-conductor/config.json from the working directory upward',
    roots,
    note: values.demo
      ? 'Only the bundled first-party demo skills are trusted; policy remains ask.'
      : 'Execution is disabled and no skill script is trusted by this scaffold.',
  });
}

async function defaultDemoConfig() {
  const cwd = process.cwd();
  const raw = JSON.parse(await fs.readFile(path.join(packageRoot, 'examples', 'config.demo.json'), 'utf8'));
  raw.roots = [{ path: path.join(packageRoot, 'skills'), namespace: 'demo', trusted: true }];
  raw.execution.enabled = true;
  raw.execution.allowlist = DEMO_IDS;
  raw.execution.trustedSkillIds = DEMO_IDS;
  // Default demo writes belong to the caller, never the installed package.
  raw.execution.runDir = path.join(cwd, '.skill-conductor', 'runs');
  raw.materials.allowRoots = [cwd, path.join(packageRoot, 'data')];
  raw.policy = { mode: 'ask' };
  return normalizeConfig(raw, { baseDir: cwd });
}

function localDemoData(configPath) {
  const candidate = path.join(path.dirname(configPath), 'demo', 'data', DEMO_DATA_NAME);
  return candidate;
}

function taskFromPositionals(positionals) {
  const task = positionals.join(' ').trim();
  if (!task) throw new Error('TASK text is required');
  return task;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function demo(values) {
  const cwd = process.cwd();
  let config;
  let dataFile;
  if (values.config) {
    const configPath = path.resolve(cwd, values.config);
    config = await loadConfig(configPath, { cwd });
    const local = localDemoData(configPath);
    dataFile = (await exists(local)) ? local : path.join(packageRoot, 'data', DEMO_DATA_NAME);
  } else {
    const discovered = await discoverConfigPath(cwd);
    if (discovered) {
      process.stderr.write(`using config: ${discovered}\n`);
      config = await loadConfig(discovered, { cwd });
      const local = localDemoData(discovered);
      dataFile = (await exists(local)) ? local : path.join(packageRoot, 'data', DEMO_DATA_NAME);
    } else {
      config = await defaultDemoConfig();
      dataFile = path.join(packageRoot, 'data', DEMO_DATA_NAME);
    }
  }
  const task = '请根据 CSV 中的销售数据统计关键指标，并生成一份 Markdown 报告。';
  const { run } = await prepareTask({
    config,
    task,
    files: [dataFile],
    phase: 'reporting',
    mode: 'auto',
    intent: 'run',
    cwd,
    verifier: async ({ execution }) => {
      const artifactDir = execution?.artifactDir ?? '';
      try {
        const [csvText, summaryText, reportText] = await Promise.all([
          fs.readFile(dataFile, 'utf8'),
          fs.readFile(path.join(artifactDir, 'csv-summary.json'), 'utf8'),
          fs.readFile(path.join(artifactDir, 'report.md'), 'utf8'),
        ]);
        const rows = csvText.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
        const headers = rows[0].split(',').map((value) => value.trim());
        const records = rows.slice(1).map((line) => line.split(',').map((value) => value.trim()));
        const amountIndex = headers.indexOf('金额');
        const quantityIndex = headers.indexOf('数量');
        const expectedAmount = records.reduce((sum, cells) => sum + Number(cells[amountIndex] || 0), 0);
        const expectedQuantity = records.reduce((sum, cells) => sum + Number(cells[quantityIndex] || 0), 0);
        const summary = JSON.parse(summaryText);
        const checks = {
          independentRowCount: summary.rowCount === records.length,
          independentAmountSum: summary.numeric?.['金额']?.sum === expectedAmount,
          independentQuantitySum: summary.numeric?.['数量']?.sum === expectedQuantity,
          reportRows: reportText.includes(`数据行数：${records.length}`),
          reportAmount: reportText.includes(`金额合计：${expectedAmount}`),
          reportQuantity: reportText.includes(`数量合计：${expectedQuantity}`),
          reportReadable: reportText.includes('销售') && reportText.length > 200,
        };
        return {
          verified: Object.values(checks).every(Boolean),
          details: {
            report: path.join(artifactDir, 'report.md'),
            checks,
            expected: {
              rows: records.length,
              amount: expectedAmount,
              quantity: expectedQuantity,
            },
          },
        };
      } catch (error) {
        return { verified: false, details: { report: artifactDir, error: error.message } };
      }
    },
  });
  emit({
    demo: 'auto opt-in (config remains ask by default)',
    skills: run.decision?.chosenIds ?? [],
    status: run.status,
    states: run.states,
    steps: run.execution?.steps?.map((step) => ({
      skillId: step.skillId,
      status: step.status,
      exitCode: step.exitCode,
      stdout: step.stdout,
    })),
    artifacts: run.execution?.steps?.flatMap((step) => step.artifacts ?? []) ?? [],
    verification: run.verification,
    artifactDir: run.execution?.artifactDir,
  });
}

const SETTING_KEYS = new Map([
  ['assistance.enabled', { type: 'boolean' }],
  ['assistance.profile', { type: 'profile' }],
  ['assistance.triggers.newTask', { type: 'boolean' }],
  ['assistance.triggers.ambiguousNewTask', { type: 'boolean' }],
  ['assistance.triggers.phaseChange', { type: 'boolean' }],
  ['assistance.triggers.materialFamilyChange', { type: 'boolean' }],
  ['assistance.triggers.requirementsChange', { type: 'boolean' }],
  ['assistance.triggers.repeatedFailure', { type: 'boolean' }],
  ['assistance.triggers.delivery', { type: 'boolean' }],
  ['assistance.triggers.smallTalkSkip', { type: 'boolean' }],
  ['assistance.triggers.simpleTaskSkip', { type: 'boolean' }],
  ['assistance.triggers.failureThreshold', { type: 'integer', min: 1, max: 20 }],
  ['assistance.triggers.deliveryRecheck', { type: 'boolean' }],
  ['assistance.budget.maxAutomaticChecksPerTask', { type: 'integer', min: 0, max: 1000 }],
  ['assistance.state.maxTasks', { type: 'integer', min: 1, max: 5000 }],
  ['policy.mode', { type: 'mode' }],
]);

function parseSettingValue(key, rawValue) {
  const spec = SETTING_KEYS.get(key);
  if (!spec) throw new Error(`unknown setting: ${key}. Known keys: ${[...SETTING_KEYS.keys()].join(', ')}`);
  const value = String(rawValue ?? '').trim();
  if (spec.type === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`${key} must be true or false`);
  }
  if (spec.type === 'integer') {
    const number = Number(value);
    if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
      throw new Error(`${key} must be an integer between ${spec.min} and ${spec.max}`);
    }
    return number;
  }
  if (spec.type === 'profile') {
    if (!['manual', 'conservative', 'balanced', 'proactive', 'custom'].includes(value)) {
      throw new Error(`${key} must be manual, conservative, balanced, proactive or custom`);
    }
    return value;
  }
  if (spec.type === 'mode') {
    if (value !== 'ask' && value !== 'auto') throw new Error(`${key} must be ask or auto`);
    return value;
  }
  throw new Error(`unsupported setting type for ${key}`);
}

function setDeep(target, dottedKey, value) {
  const parts = dottedKey.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
  return target;
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp-${process.pid}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(temp, file);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'EPERM') {
      await fs.unlink(file).catch(() => {});
      await fs.rename(temp, file);
    } else {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  }
}

async function settings(values, positionals, loadedConfig = null) {
  const action = positionals.shift() ?? 'show';
  const config = loadedConfig ?? (await requireConfig(values));
  if (!config.configPath) throw new Error('settings requires a config file with a path');
  if (action === 'show') {
    emit({
      configPath: config.configPath,
      policy: config.policy,
      assistance: config.assistance,
      explanation: assistanceExplanation(config.assistance),
      note: 'settings are owner-CLI only; MCP exposes no settings mutation or approval tool.',
    });
    return;
  }
  if (action !== 'set') throw new Error('settings action must be show or set');
  const key = positionals.shift();
  if (!key) throw new Error('settings set requires KEY VALUE');
  const rawValue = positionals.shift();
  if (rawValue === undefined) throw new Error('settings set requires KEY VALUE');
  if (positionals.length > 0) throw new Error('settings set accepts exactly one KEY and VALUE');
  const value = parseSettingValue(key, rawValue);
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(config.configPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read existing config: ${error.message}`);
  }
  setDeep(raw, key, value);
  // Validate the complete candidate before touching the real file. A malformed
  // value or inconsistent config therefore never partially overwrites settings.
  const validated = await normalizeConfig(raw, {
    baseDir: path.dirname(config.configPath),
    configPath: config.configPath,
  });
  await writeJsonAtomic(config.configPath, raw);
  emit({
    updated: true,
    key,
    value,
    configPath: config.configPath,
    policy: validated.policy,
    assistance: validated.assistance,
  });
}

function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  let closed = false;
  let rejectPending = null;
  rl.on('close', () => {
    closed = true;
    if (rejectPending) {
      rejectPending(new Error('interactive session ended without a decision'));
      rejectPending = null;
    }
  });
  rl.on('SIGINT', () => rl.close());
  return {
    get closed() {
      return closed;
    },
    ask(question) {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error('interactive session ended without a decision'));
          return;
        }
        rejectPending = reject;
        rl.question(question, (answer) => {
          rejectPending = null;
          resolve(answer);
        });
      });
    },
    close() {
      rl.close();
    },
  };
}

function describeRun(run) {
  const recommended = new Set((run.recommendation?.selected ?? []).map((entry) => entry.id));
  process.stderr.write(`\n运行：${run.runId}\n`);
  process.stderr.write(`任务：${run.task}\n`);
  if (run.phase) process.stderr.write(`阶段：${run.phase}\n`);
  if (run.recommendation?.abstainReason) {
    process.stderr.write(`选择器弃权：${run.recommendation.abstainReason}\n`);
  }
  if (run.recommendation?.selected?.length) {
    process.stderr.write('推荐：\n');
    for (const entry of run.recommendation.selected) {
      const candidate = run.candidates.find((item) => item.id === entry.id);
      process.stderr.write(
        `  * ${candidate?.name ?? entry.id}（${entry.id}）置信度=${entry.confidence}\n    理由：${entry.reason}\n`,
      );
    }
  } else {
    process.stderr.write('没有自动推荐。你仍可查看候选并手动选择。\n');
  }
  process.stderr.write('\n候选：\n');
  run.candidates.forEach((candidate, index) => {
    const flags = [
      recommended.has(candidate.id) ? '已推荐' : null,
      candidate.blocked ? `阻塞：${(candidate.blockers ?? []).join('；')}` : null,
    ]
      .filter(Boolean)
      .join('；');
    process.stderr.write(
      `  ${index + 1}. ${candidate.name ?? candidate.id} [${candidate.id}] 分数=${candidate.score}${flags ? `（${flags}）` : ''}\n`,
    );
    const reasons = (candidate.reasons ?? []).slice(0, 2).join('；');
    if (reasons) process.stderr.write(`     ${reasons}\n`);
  });
}

function interactiveSummary(run) {
  return {
    runId: run.runId,
    status: run.status,
    mode: run.mode,
    intent: run.intent,
    chosenSkills: run.decision?.chosenIds ?? [],
    skipped: run.decision?.skip ?? false,
    steps: (run.execution?.steps ?? []).map((step) => ({ skillId: step.skillId, status: step.status })),
    artifactDir: run.execution?.artifactDir ?? null,
    verification: run.verification
      ? { verified: run.verification.verified, source: run.verification.source }
      : null,
  };
}

async function interactive(values) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error('interactive 需要 TTY；脚本请使用 route + choose');
  }
  if (values.mode && !['ask', 'auto'].includes(values.mode)) {
    throw new Error('--mode 只能是 ask 或 auto');
  }
  const config = await requireConfig(values);
  const prompter = createPrompter();
  try {
    const store = new RunStore({ runDir: config.execution.runDir });
    const pendingRuns = (await store.list()).filter((entry) => entry.status === 'awaiting_choice');
    let run = null;
    if (pendingRuns.length > 0) {
      process.stderr.write('待选择的任务：\n');
      pendingRuns.forEach((entry, index) => {
        process.stderr.write(`  ${index + 1}. ${entry.task}（${entry.runId}）\n`);
      });
      let index = null;
      while (index === null) {
        const answer = (await prompter.ask(`恢复哪个任务？[1-${pendingRuns.length}，回车=1]：`)).trim();
        if (answer === '') {
          index = 0;
          break;
        }
        const parsed = Number(answer) - 1;
        if (Number.isInteger(parsed) && parsed >= 0 && parsed < pendingRuns.length) index = parsed;
        else process.stderr.write(`请输入 1-${pendingRuns.length} 之间的编号。\n`);
      }
      run = await getRun({ config, runId: pendingRuns[index].runId });
      process.stderr.write(`已恢复 ${run.runId}，保留其原有模式与执行意图。\n`);
    } else {
      const task = (await prompter.ask('任务描述（必填）：')).trim();
      if (!task) throw new Error('任务描述不能为空；空输入不会被当作批准');
      const materialAnswer = (await prompter.ask('材料文件路径（可选，多个用 ; 分隔）：')).trim();
      const files = materialAnswer
        ? materialAnswer
            .split(';')
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
      const phase = (await prompter.ask('当前阶段（可选）：')).trim() || null;
      let mode = values.mode ?? null;
      if (!mode) {
        while (!mode) {
          const answer = (
            await prompter.ask(
              '运行模式：[1] ask（默认，先由你确认） / [2] auto（本次自主选择并执行 trusted 脚本）：',
            )
          )
            .trim()
            .toLowerCase();
          if (answer === '' || answer === '1' || answer === 'ask') mode = 'ask';
          else if (answer === '2' || answer === 'auto') mode = 'auto';
          else process.stderr.write('请输入 1 或 2。空输入默认 ask，不会自动变成 auto。\n');
        }
      }
      process.stderr.write(`本次模式：${mode}\n`);
      const prepared = await prepareTask({ config, task, files, phase, mode, cwd: process.cwd() });
      if (!prepared.pendingChoice) {
        emit(interactiveSummary(prepared.run));
        return;
      }
      run = prepared.run;
    }

    describeRun(run);
    const recommended = (run.recommendation?.selected ?? [])
      .filter((entry) => !run.candidates.find((candidate) => candidate.id === entry.id)?.blocked)
      .map((entry) => entry.id);
    let choice = null;
    while (choice === null) {
      const answer = (
        await prompter.ask(
          '\n请选择：[a] 接受推荐 | 数字或 1,3 多选 | [s] 跳过 | [q] 退出且不记录决定：',
        )
      )
        .trim()
        .toLowerCase();
      if (answer === '') {
        process.stderr.write('空输入不会被视为批准，请明确选择。\n');
        continue;
      }
      if (answer === 'q') {
        process.stderr.write('未记录任何决定。\n');
        return;
      }
      if (answer === 's') {
        choice = { skip: true, skills: [] };
        break;
      }
      if (answer === 'a') {
        if (recommended.length === 0) {
          process.stderr.write('当前没有未被阻塞的推荐；请选择编号或跳过。\n');
          continue;
        }
        choice = { skip: false, skills: recommended };
        break;
      }
      const numbers = answer.split(',').map((part) => Number(part.trim()));
      if (numbers.some((value) => !Number.isInteger(value) || value < 1 || value > run.candidates.length)) {
        process.stderr.write(`选择无效；请输入 1-${run.candidates.length} 的编号。\n`);
        continue;
      }
      const chosen = [...new Set(numbers.map((value) => run.candidates[value - 1]))];
      const blocked = chosen.filter((candidate) => candidate.blocked);
      if (blocked.length > 0) {
        process.stderr.write(
          `不能选择被阻塞的候选：${blocked.map((candidate) => `${candidate.name ?? candidate.id}（${candidate.blockers.join('；')}）`).join('，')}\n`,
        );
        continue;
      }
      choice = { skip: false, skills: chosen.map((candidate) => candidate.id) };
    }

    const finalRun = await chooseRun({
      config,
      runId: run.runId,
      skills: choice.skills,
      skip: choice.skip,
      decidedBy: 'owner-interactive',
      decisionToken: run.planHash,
    });
    emit(interactiveSummary(finalRun));
  } finally {
    prompter.close();
  }
}

async function main() {
  const { values, positionals } = parse(process.argv.slice(2));
  const command = positionals.shift();
  if (!command || command === 'help' || values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (command === 'init') {
    await init(values);
    return;
  }

  if (command === 'demo') {
    await demo(values);
    return;
  }

  const config = await requireConfig(values);

  if (command === 'settings' || command === 'config') {
    await settings(values, positionals, config);
    return;
  }

  if (command === 'interactive') {
    await interactive(values);
    return;
  }

  if (command === 'list') {
    emit(await listSkills({ config }));
    return;
  }
  if (command === 'route' || command === 'run') {
    const task = taskFromPositionals(positionals);
    if (values.mode && !['ask', 'auto'].includes(values.mode)) {
      throw new Error('--mode must be ask or auto');
    }
    let activity = null;
    if (values.activity) {
      try {
        activity = JSON.parse(values.activity);
      } catch (error) {
        throw new Error(`--activity must be a JSON object: ${error.message}`);
      }
      if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
        throw new Error('--activity must be a JSON object');
      }
    }
    if (values['needs-skill'] || values.manual) {
      activity = { ...(activity ?? {}) };
      if (values['needs-skill']) activity.needsSkill = true;
      if (values.manual) activity.manualRequest = true;
    }
    const result = await prepareTask({
      config,
      task,
      files: values.material ?? [],
      phase: values.phase ?? null,
      observations: values.observe ?? [],
      mode: values.mode ?? null,
      intent: command === 'route' ? 'route' : 'run',
      cwd: process.cwd(),
      taskId: values['task-id'] ?? null,
      sessionId: values['session-id'] ?? null,
      event: values.manual ? 'manual_request' : values.event ?? null,
      activity,
    });
    emit({
      ...(result.pendingChoice ?? result.run),
      ...(result.trigger ? { trigger: result.trigger } : {}),
    });
    return;
  }
  if (command === 'choose') {
    const runId = positionals.shift();
    if (!runId) throw new Error('choose requires RUN_ID');
    const skills = (values.skills ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (!values.skip && skills.length === 0) throw new Error('choose requires --skills ID,ID or --skip');
    if (values.skip && skills.length > 0) throw new Error('use either --skills or --skip, not both');
    const run = await chooseRun({
      config,
      runId,
      skills,
      skip: values.skip,
      decidedBy: 'owner-cli',
      intent: values['activate-only'] ? 'route' : null,
    });
    emit(run);
    return;
  }
  if (command === 'show') {
    const runId = positionals.shift();
    if (!runId) throw new Error('show requires RUN_ID');
    emit(await getRun({ config, runId }));
    return;
  }
  if (command === 'runs') {
    emit(await listRuns({ config }));
    return;
  }
  if (command === 'mcp') {
    await startMcpServer({ config });
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(toErrorObject(error), null, 2)}\n`);
  process.exitCode = error?.code === 'invalid_config' ? 2 : 1;
});
