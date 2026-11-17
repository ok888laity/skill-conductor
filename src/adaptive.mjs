import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from './errors.mjs';
import { isInside, nowIso, resolveWithin, sha256, sha256File, stableStringify } from './util.mjs';

/**
 * Adaptive trigger policy.
 *
 * This module is deliberately cheap: it never reads material contents and
 * never touches the catalog. It only classifies the host-supplied event text,
 * file names and the persisted per-task session. Expensive discovery and the
 * semantic selector stay in router.mjs and are only reached after this gate
 * returns action "trigger".
 */

export const ASSISTANCE_PROFILES = ['manual', 'conservative', 'balanced', 'proactive', 'custom'];
export const TRIGGER_EVENTS = [
  'new_task',
  'routine_continuation',
  'phase_change',
  'material_family_change',
  'requirements_change',
  'repeated_failure',
  'delivery',
  'manual_request',
];

const PROFILE_DEFAULTS = {
  manual: {
    newTask: false,
    ambiguousNewTask: false,
    phaseChange: false,
    materialFamilyChange: false,
    requirementsChange: false,
    repeatedFailure: false,
    delivery: false,
    smallTalkSkip: true,
    simpleTaskSkip: true,
    failureThreshold: 2,
    deliveryRecheck: false,
    maxAutomaticChecksPerTask: 0,
  },
  conservative: {
    newTask: true,
    ambiguousNewTask: false,
    phaseChange: false,
    materialFamilyChange: true,
    requirementsChange: true,
    repeatedFailure: true,
    delivery: false,
    smallTalkSkip: true,
    simpleTaskSkip: true,
    failureThreshold: 2,
    deliveryRecheck: false,
    maxAutomaticChecksPerTask: 4,
  },
  balanced: {
    newTask: true,
    ambiguousNewTask: true,
    phaseChange: true,
    materialFamilyChange: true,
    requirementsChange: true,
    repeatedFailure: true,
    delivery: false,
    smallTalkSkip: true,
    simpleTaskSkip: true,
    failureThreshold: 2,
    deliveryRecheck: false,
    maxAutomaticChecksPerTask: 12,
  },
  proactive: {
    newTask: true,
    ambiguousNewTask: true,
    phaseChange: true,
    materialFamilyChange: true,
    requirementsChange: true,
    repeatedFailure: true,
    delivery: true,
    smallTalkSkip: true,
    simpleTaskSkip: true,
    failureThreshold: 2,
    deliveryRecheck: true,
    maxAutomaticChecksPerTask: 24,
  },
  custom: {
    newTask: true,
    ambiguousNewTask: true,
    phaseChange: true,
    materialFamilyChange: true,
    requirementsChange: true,
    repeatedFailure: true,
    delivery: false,
    smallTalkSkip: true,
    simpleTaskSkip: true,
    failureThreshold: 2,
    deliveryRecheck: false,
    maxAutomaticChecksPerTask: 12,
  },
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function bool(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ConfigError(`${field} must be a boolean`);
  return value;
}

function int(value, field, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Normalize the trusted assistance section. Old configs get safe defaults. */
export function normalizeAssistance(raw = {}) {
  if (raw === undefined) raw = {};
  if (!isObject(raw)) throw new ConfigError('assistance must be an object');
  const profile = raw.profile ?? 'balanced';
  if (!ASSISTANCE_PROFILES.includes(profile)) {
    throw new ConfigError(`assistance.profile must be one of ${ASSISTANCE_PROFILES.join(', ')}`);
  }
  const defaults = PROFILE_DEFAULTS[profile];
  const triggersRaw = raw.triggers ?? {};
  if (!isObject(triggersRaw)) throw new ConfigError('assistance.triggers must be an object');
  const budgetRaw = raw.budget ?? {};
  if (!isObject(budgetRaw)) throw new ConfigError('assistance.budget must be an object');
  const stateRaw = raw.state ?? {};
  if (!isObject(stateRaw)) throw new ConfigError('assistance.state must be an object');

  const triggers = {
    newTask: bool(triggersRaw.newTask, 'assistance.triggers.newTask', defaults.newTask),
    ambiguousNewTask: bool(
      triggersRaw.ambiguousNewTask,
      'assistance.triggers.ambiguousNewTask',
      defaults.ambiguousNewTask,
    ),
    phaseChange: bool(triggersRaw.phaseChange, 'assistance.triggers.phaseChange', defaults.phaseChange),
    materialFamilyChange: bool(
      triggersRaw.materialFamilyChange,
      'assistance.triggers.materialFamilyChange',
      defaults.materialFamilyChange,
    ),
    requirementsChange: bool(
      triggersRaw.requirementsChange,
      'assistance.triggers.requirementsChange',
      defaults.requirementsChange,
    ),
    repeatedFailure: bool(
      triggersRaw.repeatedFailure,
      'assistance.triggers.repeatedFailure',
      defaults.repeatedFailure,
    ),
    delivery: bool(triggersRaw.delivery, 'assistance.triggers.delivery', defaults.delivery),
    smallTalkSkip: bool(triggersRaw.smallTalkSkip, 'assistance.triggers.smallTalkSkip', defaults.smallTalkSkip),
    simpleTaskSkip: bool(triggersRaw.simpleTaskSkip, 'assistance.triggers.simpleTaskSkip', defaults.simpleTaskSkip),
    failureThreshold: int(
      triggersRaw.failureThreshold,
      'assistance.triggers.failureThreshold',
      defaults.failureThreshold,
      { min: 1, max: 20 },
    ),
    deliveryRecheck: bool(
      triggersRaw.deliveryRecheck,
      'assistance.triggers.deliveryRecheck',
      defaults.deliveryRecheck,
    ),
  };
  const assistance = {
    enabled: bool(raw.enabled, 'assistance.enabled', true),
    profile,
    triggers,
    budget: {
      maxAutomaticChecksPerTask: int(
        budgetRaw.maxAutomaticChecksPerTask,
        'assistance.budget.maxAutomaticChecksPerTask',
        defaults.maxAutomaticChecksPerTask,
        { min: 0, max: 1000 },
      ),
    },
    state: {
      maxTasks: int(stateRaw.maxTasks, 'assistance.state.maxTasks', 200, { min: 1, max: 5000 }),
    },
  };
  return assistance;
}

/** Human-readable, non-secret settings explanation used by the CLI. */
export function assistanceExplanation(assistance = {}) {
  const profile = assistance.profile ?? 'balanced';
  const enabled = assistance.enabled !== false;
  const triggerList = assistance.triggers ?? {};
  let active = [];
  if (enabled) {
    if (profile === 'manual') {
      active = ['manual_request'];
    } else {
      active = TRIGGER_EVENTS.filter((event) => {
        if (event === 'manual_request' || event === 'routine_continuation') return true;
        if (event === 'new_task') return triggerList.newTask !== false || triggerList.ambiguousNewTask === true;
        if (event === 'delivery') return triggerList.delivery === true || triggerList.deliveryRecheck === true;
        if (event === 'repeated_failure') return triggerList.repeatedFailure !== false;
        if (event === 'phase_change') return triggerList.phaseChange === true;
        if (event === 'material_family_change') return triggerList.materialFamilyChange === true;
        if (event === 'requirements_change') return triggerList.requirementsChange === true;
        return false;
      });
    }
  }
  return {
    enabled,
    profile,
    independentOfApprovalPolicy:
      'assistance controls when routing is checked; policy.mode ask/auto still controls who approves and whether trusted scripts may run.',
    activeEvents: active,
    notes: [
      'A cheap local gate runs first; material contents and the skill catalog are not read when it suppresses.',
      'manual ignores passive events and only reacts to an explicit manual request.',
      'Repeated identical pending choices are returned without creating a new run or prompt.',
      'A skipped owner decision suppresses the current phase until a material or requirement change.',
      'Budget exhaustion suppresses automatic checks but never becomes a fabricated no_match.',
      'Disabling assistance does not retract context already delivered nor roll back completed work.',
    ],
    triggers: triggerList,
    budget: assistance.budget ?? {},
  };
}

const SPECIALIZED_PATTERNS = [
  /\.(csv|tsv|xlsx?|json|jsonl|md|markdown|pdf|docx?|pptx?|html?|xml|yaml|yml|zip|png|jpe?g|gif|svg|mp4|mp3|wav)\b/i,
  /\b(csv|tsv|excel|spreadsheet|pdf|docx?|pptx?|markdown|report|chart|diagram|code review|transcript|subtitle)\b/i,
  /(csv|表格|数据|统计|报告|文档|审查|代码|翻译|总结|摘要|分析|提取|转换|导出|图表|幻灯片|字幕|技能|流程|脚本)/,
  /(生成|制作|整理|清洗|合并|拆分|校验|检查)/,
];

const SMALL_TALK =
  /^(hi|hello|hey|thanks|thank you|ok|okay|cool|nice|got it|好的|好|谢谢|感谢|你好|您好|嗯|收到|明白|知道了)[\s!！。.,，?？~～]*$/i;

const SIMPLE_EXPLANATION =
  /^(what is|what's|who is|why does|why is|explain|define|解释一下|解释|说明一下|什么是|为什么|怎么理解)/i;

const SIMPLE_EDIT_EN = /^(fix|rename|format|reformat|typo)\b/i;
// Natural Chinese edit requests often put the verb in the middle or use a
// result complement ("把这句话改通顺"). Match short edit wording anywhere, but
// only after specialized/file patterns have had a chance to win.
const SIMPLE_EDIT_ZH =
  /(改一下|改一改|改改|改通顺|改顺|改好|改成|改为|改掉|改错|改正|修一下|修正|修改|润色|校对|纠正|校正|改写|重命名|格式化|排版|调整语序)/;

/** Cheap lexical classification of the task text. Label: heuristic, not semantic. */
export function classifyTask(task, files = []) {
  const text = String(task ?? '').trim();
  const evidence = [];
  if (text === '') return { kind: 'empty', evidence: ['empty task text'] };
  if (files.length > 0) {
    evidence.push(`${files.length} explicit material file(s)`);
    return { kind: 'specialized', evidence };
  }
  if (SMALL_TALK.test(text)) return { kind: 'smalltalk', evidence: ['greeting or acknowledgement pattern'] };
  for (const pattern of SPECIALIZED_PATTERNS) {
    if (pattern.test(text)) {
      evidence.push(`specialized/file pattern matched: ${pattern.source}`);
      return { kind: 'specialized', evidence };
    }
  }
  if (SIMPLE_EXPLANATION.test(text) && text.length <= 80) {
    return { kind: 'simple', evidence: ['short direct explanation pattern'] };
  }
  // Chinese has no ASCII word boundary, so match edit wording anywhere in a
  // short request. This avoids an English-only gate hiding Chinese edits.
  if ((SIMPLE_EDIT_EN.test(text) || SIMPLE_EDIT_ZH.test(text)) && text.length <= 80) {
    return { kind: 'simple', evidence: ['short direct edit pattern (language-independent)'] };
  }
  evidence.push('no file or specialized-capability pattern in the task text');
  return { kind: 'ambiguous', evidence };
}

const EXTENSION_FAMILIES = {
  csv: 'spreadsheet',
  tsv: 'spreadsheet',
  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  json: 'json',
  jsonl: 'json',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  pdf: 'pdf',
  doc: 'document',
  docx: 'document',
  ppt: 'presentation',
  pptx: 'presentation',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  zip: 'archive',
  mjs: 'code',
  js: 'code',
  ts: 'code',
  py: 'code',
  java: 'code',
  go: 'code',
  rs: 'code',
};

export function classifyFileFamilies(files = []) {
  const families = new Set();
  for (const file of files) {
    if (typeof file !== 'string' || file.trim() === '') continue;
    const ext = path.extname(file).replace(/^\./, '').toLowerCase();
    families.add(EXTENSION_FAMILIES[ext] ?? (ext || 'unknown'));
  }
  return [...families].sort();
}

function safeActivity(value) {
  if (!isObject(value)) return {};
  return value;
}

export function activityEventHint(activity = {}) {
  const a = safeActivity(activity);
  return {
    needsSkill: a.needsSkill === true || a.hint === 'needs_skill' || a.event === 'needs_skill',
    manualRequest: a.manualRequest === true || a.manual_request === true,
    materialFamilies: Array.isArray(a.materialFamilies)
      ? a.materialFamilies.filter((item) => typeof item === 'string' && item.trim() !== '')
      : a.materialFamily
        ? [String(a.materialFamily)]
        : [],
    requirementsKey:
      typeof a.requirementsKey === 'string'
        ? a.requirementsKey
        : typeof a.requirementKey === 'string'
          ? a.requirementKey
          : null,
    errorFingerprint:
      typeof a.errorFingerprint === 'string'
        ? a.errorFingerprint
        : typeof a.failureFingerprint === 'string'
          ? a.failureFingerprint
          : null,
    errorCount: Number.isInteger(a.errorCount) ? a.errorCount : null,
  };
}

function normalizePhase(phase) {
  return typeof phase === 'string' && phase.trim() !== '' ? phase.trim() : null;
}

function phaseKey(phase) {
  return phase ?? '(no phase)';
}

function trigger(schema, fields) {
  return {
    schema,
    at: nowIso(),
    ...fields,
  };
}

export function triggerView(session) {
  return {
    counters: session.counters,
    budget: {
      used: session.budget?.used ?? 0,
      limit: session.budget?.limit ?? 0,
      exhausted:
        session.budget?.limit > 0 && (session.budget?.used ?? 0) >= session.budget?.limit,
    },
    phase: session.phase,
    lastEvent: session.lastEvent,
    pendingRunId: session.pending?.runId ?? null,
    lastDecisionRunId: session.decision?.runId ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Persistent task sessions                                                   */
/* -------------------------------------------------------------------------- */

const TASK_ID_MAX = 200;
const MAX_SESSION_BYTES = 256 * 1024;
const SESSION_SCHEMA = 'skill-conductor/task-session/v0.1';

function validateIdentifier(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${field} must be a non-empty string`);
  }
  if (value.length > TASK_ID_MAX) throw new ConfigError(`${field} exceeds ${TASK_ID_MAX} characters`);
  return value.trim();
}

function taskKeyFor(taskId, sessionId, config) {
  // Include workspace + explicit host session + task so the same numeric/textual
  // task id cannot inherit another session's skip, pending, no_match or budget.
  return sha256(
    `skill-conductor/task/${path.resolve(config.baseDir)}/${sessionId ?? '(no-session)'}/${taskId}`,
  );
}

function sessionsDir(config) {
  return path.join(config.execution.runDir, 'task-sessions');
}

function sessionFile(config, taskKey) {
  if (!/^[a-f0-9]{64}$/.test(taskKey)) throw new ConfigError('invalid task session key');
  return path.join(sessionsDir(config), `${taskKey}.json`);
}

function freshSession({ taskId, sessionId, config }) {
  return {
    schema: SESSION_SCHEMA,
    taskKey: taskKeyFor(taskId, sessionId, config),
    taskId,
    sessionId: sessionId ?? null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    counters: {
      gateChecks: 0,
      selectorCalls: 0,
      cacheReuse: 0,
      ownerPrompts: 0,
      executions: 0,
    },
    budget: { used: 0, limit: config.assistance.budget.maxAutomaticChecksPerTask },
    phase: null,
    lastEvent: null,
    materialFamilies: [],
    requirementKey: null,
    pending: null,
    decision: null,
    noMatch: null,
    skippedPhases: {},
    failures: {},
    executedRunIds: [],
    lastOutcome: null,
    taskKind: null,
  };
}

export async function loadTaskSession({ config, taskId, sessionId = null }) {
  validateIdentifier(taskId, 'taskId');
  if (sessionId !== null && sessionId !== undefined) validateIdentifier(sessionId, 'sessionId');
  const taskKey = taskKeyFor(taskId, sessionId, config);
  const file = sessionFile(config, taskKey);
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!raw || raw.schema !== SESSION_SCHEMA || raw.taskKey !== taskKey) {
      return freshSession({ taskId, sessionId, config });
    }
    // Safe defaults for sessions written by an earlier build.
    raw.counters = {
      gateChecks: 0,
      selectorCalls: 0,
      cacheReuse: 0,
      ownerPrompts: 0,
      executions: 0,
      ...(raw.counters ?? {}),
    };
    raw.budget = { used: 0, limit: config.assistance.budget.maxAutomaticChecksPerTask, ...(raw.budget ?? {}) };
    raw.budget.limit = config.assistance.budget.maxAutomaticChecksPerTask;
    raw.skippedPhases = raw.skippedPhases ?? {};
    raw.failures = raw.failures ?? {};
    raw.noMatch = raw.noMatch ?? null;
    raw.executedRunIds = Array.isArray(raw.executedRunIds) ? raw.executedRunIds : [];
    if (sessionId) raw.sessionId = sessionId;
    return raw;
  } catch (error) {
    if (error.code === 'ENOENT') return freshSession({ taskId, sessionId, config });
    throw new ConfigError(`cannot read task session: ${error.message}`);
  }
}

export async function saveTaskSession({ config, session }) {
  if (!session || typeof session !== 'object') throw new ConfigError('session must be an object');
  // Bound persistent state even if a host supplies unbounded failure or phase sets.
  const failureEntries = Object.entries(session.failures ?? {})
    .sort((a, b) => String(b[1]?.lastAt ?? '').localeCompare(String(a[1]?.lastAt ?? '')))
    .slice(0, 20);
  session.failures = Object.fromEntries(failureEntries);
  session.executedRunIds = [...new Set(session.executedRunIds ?? [])].slice(-50);
  const skippedEntries = Object.entries(session.skippedPhases ?? {})
    .sort((a, b) => String(b[1]?.at ?? '').localeCompare(String(a[1]?.at ?? '')))
    .slice(0, 50);
  session.skippedPhases = Object.fromEntries(skippedEntries);
  session.updatedAt = nowIso();
  const dir = sessionsDir(config);
  await fs.mkdir(dir, { recursive: true });
  const file = sessionFile(config, session.taskKey);
  const payload = `${JSON.stringify(session, null, 2)}\n`;
  if (Buffer.byteLength(payload) > MAX_SESSION_BYTES) {
    throw new ConfigError(`task session exceeds ${MAX_SESSION_BYTES} bytes`);
  }
  const temp = `${file}.tmp-${process.pid}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  await fs.writeFile(temp, payload, 'utf8');
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
  await pruneTaskSessions(config, session.taskKey);
  return session;
}

async function pruneTaskSessions(config, keepKey) {
  const maxTasks = config.assistance.state.maxTasks;
  const dir = sessionsDir(config);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    const key = entry.name.slice(0, -5);
    try {
      const stat = await fs.stat(file);
      files.push({ file, key, mtimeMs: stat.mtimeMs });
    } catch {
      // ignore
    }
  }
  if (files.length <= maxTasks) return;
  const candidates = files.filter((item) => item.key !== keepKey).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let remaining = files.length;
  for (const item of candidates) {
    if (remaining <= maxTasks) break;
    await fs.unlink(item.file).catch(() => {});
    remaining -= 1;
  }
}

/* -------------------------------------------------------------------------- */
/* Cheap gate                                                                 */
/* -------------------------------------------------------------------------- */

function taskFingerprint({ task, phase, files, families, requirementKey, activity }) {
  return sha256(
    stableStringify({
      schema: 'skill-conductor/trigger-fingerprint/v0.1',
      task: String(task ?? '').trim(),
      phase: normalizePhase(phase),
      files: [...files].map((file) => String(file)).sort(),
      families: [...families].sort(),
      requirementKey: requirementKey ?? null,
      needsSkill: activity.needsSkill === true,
    }),
  );
}

async function fileSignature(files) {
  const signature = [];
  for (const file of files) {
    if (typeof file !== 'string' || file.trim() === '') continue;
    const abs = path.resolve(file);
    try {
      const stat = await fs.stat(abs);
      signature.push({ path: abs, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
    } catch {
      signature.push({ path: abs, missing: true });
    }
  }
  return signature.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Metadata-only catalog signature. It walks directory entries (never SKILL.md
 * bodies) so adding/removing grouped skill directories invalidates a reused
 * decision without performing a full discovery parse. Selected skill/script
 * hashes remain the authoritative content check.
 */
export async function catalogSignature(config) {
  const roots = [];
  let budget = 400;
  for (const root of config.roots) {
    const entries = [];
    const queue = [{ dir: root.path, depth: 0 }];
    while (queue.length > 0 && budget > 0) {
      const current = queue.shift();
      let stat;
      try {
        stat = await fs.stat(current.dir);
      } catch {
        entries.push({ path: current.dir, mtimeMs: 'missing' });
        continue;
      }
      entries.push({ path: current.dir, mtimeMs: Math.round(stat.mtimeMs) });
      budget -= 1;
      if (current.depth >= 3) continue;
      let children;
      try {
        children = await fs.readdir(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        if (child.name === '.git' || child.name === 'node_modules') continue;
        queue.push({ dir: path.join(current.dir, child.name), depth: current.depth + 1 });
      }
    }
    roots.push({ path: root.path, namespace: root.namespace, entries, truncated: budget <= 0 });
  }
  return sha256(stableStringify(roots));
}

function baseTrigger({ action, event, reasonCode, explanation, profile, automatic, session, extra = {} }) {
  return trigger('skill-conductor/trigger/v0.1', {
    action,
    event,
    reasonCode,
    explanation,
    profile,
    automatic,
    taskId: session?.taskId ?? null,
    sessionId: session?.sessionId ?? null,
    counters: session?.counters ?? null,
    budget: session
      ? {
          used: session.budget?.used ?? 0,
          limit: session.budget?.limit ?? 0,
          exhausted:
            (session.budget?.limit ?? 0) > 0 && (session.budget?.used ?? 0) >= (session.budget?.limit ?? 0),
        }
      : null,
    ...extra,
  });
}

function budgetExhausted(session) {
  const limit = session.budget?.limit ?? 0;
  return limit > 0 && (session.budget?.used ?? 0) >= limit;
}

function newTaskReset(session, config) {
  session.budget = { used: 0, limit: config.assistance.budget.maxAutomaticChecksPerTask };
  session.phase = null;
  session.materialFamilies = [];
  session.requirementKey = null;
  session.pending = null;
  session.decision = null;
  session.noMatch = null;
  session.skippedPhases = {};
  session.failures = {};
  session.executedRunIds = [];
  session.lastOutcome = null;
  session.taskKind = null;
}

/**
 * Decide whether expensive skill discovery is justified.
 *
 * Inputs are host-supplied task/event data only. No files are opened here
 * beyond stat() metadata and no catalog is scanned.
 */
export async function evaluateAdaptiveTrigger({
  config,
  taskId = null,
  sessionId = null,
  task,
  files = [],
  phase = null,
  event = null,
  activity = null,
}) {
  const a = activityEventHint(activity);
  if (!config.assistance.enabled) {
    return {
      action: 'disabled',
      session: null,
      trigger: trigger('skill-conductor/trigger/v0.1', {
        action: 'disabled',
        event: event ?? 'new_task',
        reasonCode: 'disabled_total_switch',
        explanation:
          'assistance.enabled is false; no materials were read, no catalog scanned and no selector or executor was called.',
        profile: config.assistance.profile,
        automatic: true,
        disabled: true,
      }),
    };
  }

  const manualRequest = (event === 'manual_request') || a.manualRequest;
  if (!taskId) {
    if (config.assistance.profile === 'manual' && !manualRequest) {
      return {
        action: 'suppress',
        session: null,
        trigger: trigger('skill-conductor/trigger/v0.1', {
          action: 'suppress',
          event: event ?? 'routine_continuation',
          reasonCode: 'manual_profile_passive',
          explanation:
            'Profile manual only reacts to an explicit manual request; no taskId was supplied, so passive one-shot routing was suppressed.',
          profile: 'manual',
          automatic: false,
        }),
      };
    }
    return {
      action: 'trigger',
      session: null,
      legacy: true,
      trigger: trigger('skill-conductor/trigger/v0.1', {
        action: 'trigger',
        event: event ?? (manualRequest ? 'manual_request' : 'new_task'),
        reasonCode: manualRequest ? 'manual_request' : 'legacy_one_shot',
        explanation:
          'No explicit taskId/context was supplied, so the documented v0.1 one-shot behavior is preserved (total switch and manual profile still apply).',
        profile: config.assistance.profile,
        automatic: !manualRequest,
      }),
    };
  }

  const session = await loadTaskSession({ config, taskId, sessionId });
  session.counters.gateChecks += 1;

  const phaseNow = normalizePhase(phase ?? activity?.phase ?? session.phase);
  const families = [
    ...new Set([...classifyFileFamilies(files), ...a.materialFamilies.map((item) => item.trim())]),
  ].sort();
  const requirementKey = a.requirementsKey ?? session.requirementKey ?? null;
  const isNewTask = !session.lastEvent && !session.pending && !session.decision && session.counters.gateChecks === 1;
  let resolvedEvent = event;
  if (resolvedEvent === 'needs_skill') resolvedEvent = null;

  if (!resolvedEvent && isNewTask) resolvedEvent = 'new_task';
  if (!resolvedEvent) {
    if (a.needsSkill) resolvedEvent = 'new_task';
    else if (phaseNow !== session.phase && session.phase !== null) resolvedEvent = 'phase_change';
    else if (
      session.materialFamilies.length > 0 &&
      families.length > 0 &&
      stableStringify(families) !== stableStringify(session.materialFamilies)
    ) {
      resolvedEvent = 'material_family_change';
    } else if (requirementKey !== null && session.requirementKey !== null && requirementKey !== session.requirementKey) {
      resolvedEvent = 'requirements_change';
    } else resolvedEvent = session.decision || session.pending ? 'routine_continuation' : 'new_task';
  }
  if (!TRIGGER_EVENTS.includes(resolvedEvent)) {
    throw new ConfigError(`unsupported trigger event: ${resolvedEvent}`);
  }

  const fingerprint = taskFingerprint({ task, phase: phaseNow, files, families, requirementKey, activity: a });
  const fileSig = await fileSignature(files);

  // An unchanged repeat never creates a second pending prompt.
  if (
    session.pending &&
    session.pending.fingerprint === fingerprint &&
    (session.pending.configFingerprint ?? config.fingerprint) === config.fingerprint &&
    resolvedEvent === 'routine_continuation'
  ) {
    await saveTaskSession({ config, session });
    return {
      action: 'pending',
      session,
      trigger: baseTrigger({
        action: 'pending',
        event: resolvedEvent,
        reasonCode: 'pending_unchanged',
        explanation:
          'The same pending owner choice already exists for this task/phase/input fingerprint; returning it without a new selector call or prompt.',
        profile: config.assistance.profile,
        automatic: false,
        session,
        extra: { pendingRunId: session.pending.runId, fingerprint },
      }),
    };
  }

  if (resolvedEvent === 'new_task') {
    newTaskReset(session, config);
  }

  const finish = async (result) => {
    session.lastEvent = resolvedEvent;
    if (resolvedEvent === 'new_task' || resolvedEvent === 'routine_continuation') {
      session.taskKind = classifyTask(task, files).kind;
    }
    session.phase = phaseNow;
    session.materialFamilies = families;
    if (requirementKey !== null) session.requirementKey = requirementKey;
    await saveTaskSession({ config, session });
    return {
      ...result,
      session,
      trigger: baseTrigger({
        action: result.action,
        event: resolvedEvent,
        reasonCode: result.reasonCode,
        explanation: result.explanation,
        profile: config.assistance.profile,
        automatic: result.action === 'trigger' && !manualRequest,
        session,
        extra: {
          fingerprint,
          phase: phaseNow,
          materialFamilies: families,
          requirementKey,
          fileSignature: fileSig,
          ...(result.extra ?? {}),
        },
      }),
    };
  };

  if (manualRequest) {
    // Manual requests never consume the automatic budget.
    return finish({
      action: 'trigger',
      reasonCode: 'manual_request',
      explanation:
        'An explicit manual request bypasses frequency suppression and the automatic budget. It cannot override the total switch, trust or owner approval.',
    });
  }

  if (config.assistance.profile === 'manual') {
    return finish({
      action: 'suppress',
      reasonCode: 'manual_profile_passive',
      explanation:
        'Profile manual ignores passive events. Send event "manual_request" when routing should be checked.',
    });
  }

  // Owner skip suppresses the current phase until materials/requirements change.
  const skipped = session.skippedPhases?.[phaseKey(phaseNow)];
  const materiallyChanged =
    resolvedEvent === 'material_family_change' ||
    resolvedEvent === 'requirements_change' ||
    resolvedEvent === 'new_task' ||
    (families.length > 0 && stableStringify(families) !== stableStringify(session.materialFamilies));
  if (skipped && !materiallyChanged && session.pending?.runId !== skipped.runId) {
    return finish({
      action: 'suppress',
      reasonCode: 'owner_skipped_phase',
      explanation: `The owner skipped this task in phase ${phaseKey(phaseNow)}; automatic checks stay suppressed until a material or requirement change or a new task.`,
      extra: { skippedRunId: skipped.runId },
    });
  }

  if (
    resolvedEvent === 'delivery' &&
    !config.assistance.triggers.deliveryRecheck &&
    !config.assistance.triggers.delivery
  ) {
    return finish({
      action: 'suppress',
      reasonCode: 'delivery_recheck_disabled',
      explanation:
        'Delivery recheck is off by default. Set assistance.triggers.deliveryRecheck=true to recheck at delivery.',
    });
  }

  if (resolvedEvent === 'repeated_failure') {
    if (!config.assistance.triggers.repeatedFailure) {
      return finish({
        action: 'suppress',
        reasonCode: 'repeated_failure_disabled',
        explanation: 'Repeated-failure triggering is disabled in this assistance profile.',
      });
    }
    const failureKey =
      a.errorFingerprint ?? sha256(`failure:${String(activity?.error ?? activity?.message ?? task ?? '').trim()}`);
    const threshold = config.assistance.triggers.failureThreshold;
    const record = session.failures[failureKey] ?? { count: 0, triggeredAt: null, firstAt: nowIso(), lastAt: null };
    record.count += 1;
    record.lastAt = nowIso();
    session.failures[failureKey] = record;
    if (record.triggeredAt) {
      return finish({
        action: 'suppress',
        reasonCode: 'repeated_failure_deduped',
        explanation: `The same failure fingerprint was already used to trigger routing at count ${record.count}; it will not repeat until materials, requirements or phase change.`,
        extra: { failureFingerprint: failureKey, failureCount: record.count },
      });
    }
    if (record.count < threshold) {
      return finish({
        action: 'suppress',
        reasonCode: 'repeated_failure_threshold',
        explanation: `Failure count ${record.count} is below the configured threshold ${threshold}; existing context continues.`,
        extra: { failureFingerprint: failureKey, failureCount: record.count, threshold },
      });
    }
    if (budgetExhausted(session)) {
      return finish({
        action: 'suppress',
        reasonCode: 'budget_exhausted',
        explanation: `The same failure reached threshold ${threshold}, but the automatic expensive-check budget (${session.budget.limit}) is exhausted. Existing context continues; send event "manual_request" for a check. This is not a no_match result.`,
        extra: {
          attemptedReasonCode: 'repeated_failure_threshold_reached',
          failureFingerprint: failureKey,
          failureCount: record.count,
        },
      });
    }
    record.triggeredAt = nowIso();
    session.budget.used += 1;
    return finish({
      action: 'trigger',
      reasonCode: 'repeated_failure_threshold_reached',
      explanation: `The same failure reached the threshold ${threshold}; routing is checked once for this fingerprint.`,
      extra: { failureFingerprint: failureKey, failureCount: record.count, threshold },
    });
  }

  // A change in phase/family/requirements resets failure dedupe: this is material change.
  if (
    resolvedEvent === 'phase_change' ||
    resolvedEvent === 'material_family_change' ||
    resolvedEvent === 'requirements_change'
  ) {
    session.failures = {};
  }

  let shouldTrigger = false;
  let reasonCode = 'no_prior_decision';
  let explanation = '';

  if (resolvedEvent === 'new_task') {
    const classification = classifyTask(task, files);
    if (a.needsSkill) {
      shouldTrigger = true;
      reasonCode = 'new_task_needs_skill';
      explanation = 'The host signalled needsSkill=true for a new task.';
    } else if (classification.kind === 'smalltalk' && config.assistance.triggers.smallTalkSkip) {
      return finish({
        action: 'suppress',
        reasonCode: 'new_task_smalltalk_skip',
        explanation: 'Obvious small talk or acknowledgement is skipped at balanced/conservative frequency.',
        extra: { classification: classification.kind, evidence: classification.evidence },
      });
    } else if (classification.kind === 'simple' && config.assistance.triggers.simpleTaskSkip) {
      return finish({
        action: 'suppress',
        reasonCode: 'new_task_simple_skip',
        explanation:
          'Obvious one-sentence edits or direct simple explanations are skipped at balanced/conservative frequency.',
        extra: { classification: classification.kind, evidence: classification.evidence },
      });
    } else if (classification.kind === 'specialized') {
      shouldTrigger = true;
      reasonCode = 'new_task_specialized';
      explanation = 'A new task explicitly needs file processing or a specialized capability.';
    } else if (classification.kind === 'ambiguous') {
      if (config.assistance.profile === 'conservative') {
        return finish({
          action: 'suppress',
          reasonCode: 'new_task_ambiguous_conservative',
          explanation:
            'Conservative profile suppresses ambiguous new tasks unless the host sets needsSkill=true. Ambiguous text is not assumed to be simple.',
          extra: { classification: classification.kind, evidence: classification.evidence },
        });
      }
      if (!config.assistance.triggers.ambiguousNewTask) {
        return finish({
          action: 'suppress',
          reasonCode: 'new_task_ambiguous_disabled',
          explanation: 'Ambiguous-new-task triggering is disabled in this profile.',
          extra: { classification: classification.kind, evidence: classification.evidence },
        });
      }
      shouldTrigger = true;
      reasonCode = 'new_task_ambiguous_cautious';
      explanation =
        'The task text is neither obvious small talk/simple editing nor clearly specialized, so the cautious fallback checks routing. This is not English-only: Chinese and other non-ASCII text take the same path.';
    } else {
      shouldTrigger = true;
      reasonCode = 'new_task_empty_context';
      explanation = 'A new task has no usable classification; the cautious fallback checks routing.';
    }
    if (!config.assistance.triggers.newTask && !a.needsSkill) {
      return finish({
        action: 'suppress',
        reasonCode: 'new_task_disabled',
        explanation: 'New-task automatic triggering is disabled for this profile.',
      });
    }
  } else if (resolvedEvent === 'phase_change') {
    if (!config.assistance.triggers.phaseChange) {
      return finish({
        action: 'suppress',
        reasonCode: 'phase_change_disabled',
        explanation: 'Phase-change triggering is disabled for this profile.',
      });
    }
    shouldTrigger = true;
    reasonCode = 'phase_changed';
    explanation = `The explicit phase changed from ${session.phase ?? '(none)'} to ${phaseNow ?? '(none)'}.`;
  } else if (resolvedEvent === 'material_family_change') {
    if (!config.assistance.triggers.materialFamilyChange) {
      return finish({
        action: 'suppress',
        reasonCode: 'material_family_change_disabled',
        explanation: 'Material-family-change triggering is disabled for this profile.',
      });
    }
    shouldTrigger = true;
    reasonCode = 'material_family_changed';
    explanation = `The explicit material family changed from ${JSON.stringify(session.materialFamilies)} to ${JSON.stringify(families)}.`;
  } else if (resolvedEvent === 'requirements_change') {
    if (!config.assistance.triggers.requirementsChange) {
      return finish({
        action: 'suppress',
        reasonCode: 'requirements_change_disabled',
        explanation: 'Requirements-change triggering is disabled for this profile.',
      });
    }
    shouldTrigger = true;
    reasonCode = 'requirements_changed';
    explanation = 'The host supplied a changed requirements key.';
  } else if (resolvedEvent === 'delivery') {
    shouldTrigger = true;
    reasonCode = 'delivery_recheck';
    explanation = 'Delivery recheck is enabled; routing is checked before delivery.';
  } else {
    // routine_continuation
    if (a.needsSkill) {
      shouldTrigger = true;
      reasonCode = 'routine_needs_skill';
      explanation = 'The host signalled needsSkill=true during an otherwise routine continuation.';
    } else if (
      session.noMatch &&
      session.noMatch.phaseKey === phaseKey(phaseNow) &&
      stableStringify(session.noMatch.materialFamilies ?? []) === stableStringify(families) &&
      (session.noMatch.requirementKey ?? null) === (requirementKey ?? null)
    ) {
      return finish({
        action: 'suppress',
        reasonCode: 'no_match_suppressed',
        explanation:
          'This task/phase already produced a real no_match. The selector is not called again for the same material family and requirements; a material/requirement/phase change or manual request can recheck. This suppression is not a new no_match result.',
        extra: { sourceRunId: session.noMatch.runId, matchedFingerprint: session.noMatch.fingerprint },
      });
    } else if (session.decision) {
      const validation = await validateCachedDecision({ config, session });
      if (validation.valid) {
        return finish({
          action: 'reuse',
          reasonCode: 'routine_reuse',
          explanation:
            'Same task and phase with no material/requirement/needsSkill change; reuse the prior decision and loaded context without another selector call or execution.',
          extra: {
            sourceRunId: session.decision.runId,
            fingerprint,
            cachedDecision: {
              selectedIds: session.decision.selectedIds,
              catalogHash: session.decision.catalogHash,
            },
          },
        });
      }
      if (budgetExhausted(session)) {
        return finish({
          action: 'suppress',
          reasonCode: 'budget_exhausted',
          explanation: `Cached context was invalidated (${validation.detail}) but the automatic expensive-check budget is exhausted. Existing context continues; send event "manual_request" for a check. This is not a no_match result.`,
          extra: { invalidation: validation.reasonCode },
        });
      }
      session.budget.used += 1;
      return finish({
        action: 'trigger',
        reasonCode: validation.reasonCode,
        explanation: `Cached decision cannot be reused: ${validation.detail}. Re-running discovery, not silently reusing stale instructions.`,
        extra: { fingerprint },
      });
    } else if (
      (session.taskKind === 'smalltalk' && config.assistance.triggers.smallTalkSkip) ||
      (session.taskKind === 'simple' && config.assistance.triggers.simpleTaskSkip)
    ) {
      return finish({
        action: 'suppress',
        reasonCode: session.taskKind === 'smalltalk' ? 'new_task_smalltalk_skip' : 'new_task_simple_skip',
        explanation:
          'This task was already classified as obvious small talk or a direct simple edit; continuation stays suppressed.',
        extra: { classification: session.taskKind },
      });
    } else {
      shouldTrigger = true;
      reasonCode = 'no_prior_decision';
      explanation = 'Routine continuation has no prior decision to reuse.';
    }
  }

  if (shouldTrigger && budgetExhausted(session)) {
    return finish({
      action: 'suppress',
      reasonCode: 'budget_exhausted',
      explanation: `The automatic expensive-check budget (${session.budget.limit}) for this task is exhausted. Existing context continues; send event "manual_request" for an owner-requested check. This is not a no_match result.`,
      extra: { attemptedReasonCode: reasonCode },
    });
  }
  if (shouldTrigger && !manualRequest) session.budget.used += 1;
  return finish({
    action: 'trigger',
    reasonCode,
    explanation,
    extra: {
      ...(resolvedEvent === 'new_task'
        ? { classification: classifyTask(task, files).kind, evidence: classifyTask(task, files).evidence }
        : {}),
    },
  });
}

/** Count one actual selector invocation for this task session. */
export async function recordSelectorCall({ config, taskId, sessionId = null }) {
  if (!taskId) return null;
  const session = await loadTaskSession({ config, taskId, sessionId });
  session.counters.selectorCalls += 1;
  await saveTaskSession({ config, session });
  return session;
}

/** Mark that the gate produced a new owner prompt (unique pending choice). */
export async function recordPending({ config, run, fingerprint = null }) {
  if (!run?.taskId) return null;
  const session = await loadTaskSession({ config, taskId: run.taskId, sessionId: run.sessionId });
  if (session.taskKey !== run.taskKey) return null;
  session.pending = {
    runId: run.runId,
    fingerprint: fingerprint ?? run.adaptive?.fingerprint ?? null,
    configFingerprint: run.configFingerprint ?? null,
    planHash: run.planHash ?? null,
    phase: run.phase ?? null,
    at: nowIso(),
  };
  session.counters.ownerPrompts += 1;
  await saveTaskSession({ config, session });
  return session;
}

/** Record a real no_match so unchanged routine continuations do not re-query. */
export async function recordNoMatch({ config, run }) {
  if (!run?.taskId) return null;
  const session = await loadTaskSession({ config, taskId: run.taskId, sessionId: run.sessionId });
  if (session.taskKey !== run.taskKey) return null;
  session.pending = null;
  session.noMatch = {
    runId: run.runId,
    fingerprint: run.adaptive?.fingerprint ?? null,
    phase: run.phase ?? null,
    phaseKey: phaseKey(run.phase ?? null),
    materialFamilies: run.adaptive?.materialFamilies ?? [],
    requirementKey: run.adaptive?.requirementKey ?? null,
    reason: run.recommendation?.abstainReason ?? 'selector returned no usable skill',
    at: nowIso(),
  };
  session.lastOutcome = 'no_match';
  await saveTaskSession({ config, session });
  return session;
}

/** Count one successful cache/context reuse (no selector and no execution). */
export async function recordReuse({ config, taskId, sessionId = null }) {
  if (!taskId) return null;
  const session = await loadTaskSession({ config, taskId, sessionId });
  session.counters.cacheReuse += 1;
  await saveTaskSession({ config, session });
  return session;
}

/** Clear pending and cache a reusable decision after activation/execution. */
export async function recordRunDecision({ config, run, activated = false }) {
  if (!run?.taskId) return null;
  const session = await loadTaskSession({ config, taskId: run.taskId, sessionId: run.sessionId });
  if (session.taskKey !== run.taskKey) return null;
  const selectedIds = run.decision?.chosenIds ?? (run.recommendation?.selected ?? []).map((entry) => entry.id);
  const selectedCandidates = (run.candidates ?? []).filter((candidate) => selectedIds.includes(candidate.id));
  session.pending = null;
  if (run.status === 'no_match') {
    session.noMatch = {
      runId: run.runId,
      fingerprint: run.adaptive?.fingerprint ?? null,
      phase: run.phase ?? null,
      phaseKey: phaseKey(run.phase ?? null),
      materialFamilies: run.adaptive?.materialFamilies ?? [],
      requirementKey: run.adaptive?.requirementKey ?? null,
      reason: run.recommendation?.abstainReason ?? null,
      at: nowIso(),
    };
  } else if (run.status !== 'skipped' && run.status !== 'suppressed' && run.status !== 'disabled') {
    session.noMatch = null;
  }
  session.lastOutcome = run.status;
  if (run.context) {
    session.decision = {
      runId: run.runId,
      phase: run.phase ?? null,
      selectedIds,
      catalogHash: run.catalogHash ?? null,
      catalogSignature: run.adaptive?.catalogSignature ?? null,
      configFingerprint: run.configFingerprint ?? null,
      materialFamilies: run.adaptive?.materialFamilies ?? [],
      requirementKey: run.adaptive?.requirementKey ?? null,
      skillHashes: selectedCandidates.map((candidate) => ({
        id: candidate.id,
        skillFile: candidate.skillFile,
        realDir: candidate.realDir,
        sha256: candidate.sha256,
        sidecarFile: candidate.sidecarFile,
        sidecarSha256: candidate.sidecarSha256 ?? null,
        executableEntry: candidate.executable?.entry ?? null,
        executableSha256: candidate.executable?.sha256 ?? null,
      })),
      at: nowIso(),
    };
  }
  if (run.decision?.skip) {
    session.skippedPhases[phaseKey(run.phase ?? null)] = {
      runId: run.runId,
      at: nowIso(),
    };
  }
  if (run.states?.executed && !session.executedRunIds.includes(run.runId)) {
    session.executedRunIds.push(run.runId);
    session.counters.executions += 1;
  }
  await saveTaskSession({ config, session });
  return session;
}

/** Validate a cached decision before promising reuse. */
export async function validateCachedDecision({ config, session }) {
  const decision = session?.decision;
  if (!decision) return { valid: false, reasonCode: 'no_prior_decision', detail: 'no activated decision is cached' };
  if (decision.configFingerprint && decision.configFingerprint !== config.fingerprint) {
    return { valid: false, reasonCode: 'cache_invalidated_config', detail: 'config/trust fingerprint changed' };
  }
  const signature = await catalogSignature(config);
  if (decision.catalogSignature && decision.catalogSignature !== signature) {
    return { valid: false, reasonCode: 'cache_invalidated_catalog', detail: 'catalog root directory changed' };
  }
  for (const entry of decision.skillHashes ?? []) {
    try {
      if (entry.skillFile) {
        const actual = await sha256File(entry.skillFile);
        if (actual.sha256 !== entry.sha256) {
          return { valid: false, reasonCode: 'cache_invalidated_skill', detail: `SKILL.md changed: ${entry.id}` };
        }
      }
      if (entry.sidecarFile && entry.sidecarSha256) {
        const actual = await sha256File(entry.sidecarFile);
        if (actual.sha256 !== entry.sidecarSha256) {
          return { valid: false, reasonCode: 'cache_invalidated_sidecar', detail: `conductor.json changed: ${entry.id}` };
        }
      }
      if (entry.realDir && entry.executableEntry && entry.executableSha256) {
        const script = await resolveWithin(entry.realDir, entry.executableEntry, { mustExist: true });
        if (!isInside(entry.realDir, script)) {
          return { valid: false, reasonCode: 'cache_invalidated_script', detail: `script escaped: ${entry.id}` };
        }
        const actual = await sha256File(script);
        if (actual.sha256 !== entry.executableSha256) {
          return { valid: false, reasonCode: 'cache_invalidated_script', detail: `script changed: ${entry.id}` };
        }
      }
    } catch (error) {
      return { valid: false, reasonCode: 'cache_invalidated_skill', detail: error.message };
    }
  }
  return { valid: true, reasonCode: 'cache_valid', decision };
}

export function taskSessionSummary(session) {
  if (!session) return null;
  return {
    schema: session.schema,
    taskId: session.taskId,
    taskKey: session.taskKey,
    phase: session.phase,
    lastEvent: session.lastEvent,
    ...triggerView(session),
  };
}
