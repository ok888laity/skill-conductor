import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isInside,
  killProcessTree,
  nowIso,
  redactSecrets,
  resolveWithin,
  sha256File,
  spawnWithTreeKill,
} from './util.mjs';

const SAFE_ENV_KEYS = new Set([
  'path',
  'systemroot',
  'windir',
  'comspec',
  'pathext',
  'temp',
  'tmp',
  'home',
  'userprofile',
  'lang',
  'lc_all',
  'tz',
]);

function childEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && SAFE_ENV_KEYS.has(key.toLowerCase())) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/** Decide whether a sidecar-declared script is explicitly trusted for this config. */
export function executionTrust(skill, config) {
  if (!skill.executable) return { trusted: false, reason: 'skill has no conductor.json executable' };
  if (!config.execution.enabled) return { trusted: false, reason: 'execution.enabled is false' };
  if (!config.execution.trustedSkillIds.includes(skill.id)) {
    return { trusted: false, reason: 'skill id is not in execution.trustedSkillIds' };
  }
  if (config.execution.allowlist.length > 0 && !config.execution.allowlist.includes(skill.id)) {
    return { trusted: false, reason: 'skill id is not in execution.allowlist' };
  }
  if (skill.executable.runtime !== 'node') {
    return { trusted: false, reason: 'only node executables are supported' };
  }
  return { trusted: true, reason: null };
}

function boundedAppend(chunks, currentBytes, chunk, limit) {
  if (currentBytes >= limit) return { bytes: currentBytes, over: true, text: '' };
  const remaining = limit - currentBytes;
  const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(slice);
  return { bytes: currentBytes + slice.length, over: chunk.length > remaining, text: '' };
}

async function inventory(dir, { maxArtifacts = 50, maxHashBytes = 4 * 1024 * 1024 } = {}) {
  const found = [];
  async function walk(current, prefix, depth) {
    if (found.length >= maxArtifacts || depth > 6) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= maxArtifacts) return;
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(abs);
        let hash = null;
        if (stat.size <= maxHashBytes) hash = (await sha256File(abs)).sha256;
        found.push({ name: rel, bytes: stat.size, sha256: hash, modifiedAt: stat.mtime.toISOString() });
      } catch {
        // directory changed while scanning
      }
    }
  }
  await walk(dir, '', 0);
  return found;
}

/**
 * Run one explicitly trusted conductor.json script. No shell, no model-supplied
 * path, real timeout with process-tree kill, bounded stdout/stderr and artifacts.
 * Success here is execution evidence only; it is not independent verification.
 */
export async function runTrustedSkill({ skill, step, run, config, artifactDir, input = {} }) {
  const trust = executionTrust(skill, config);
  if (!trust.trusted) return { status: 'handoff', reason: trust.reason, skillId: skill.id };

  let script;
  try {
    script = await resolveWithin(skill.realDir, skill.executable.entry);
    const stat = await fs.stat(script);
    if (!stat.isFile()) throw new Error('entry is not a regular file');
  } catch (error) {
    return { status: 'failed', skillId: skill.id, error: `invalid executable entry: ${error.message}` };
  }

  await fs.mkdir(artifactDir, { recursive: true });
  const before = new Set((await inventory(artifactDir, { maxArtifacts: config.execution.maxArtifacts })).map((item) => item.name));

  const payload = {
    schema: 'skill-conductor/execution-input/v0.1',
    runId: run.runId,
    skillId: skill.id,
    stepId: step.id,
    task: run.task,
    phase: run.phase ?? null,
    materials: run.materials ?? [],
    artifactDir,
    ...input,
  };

  const started = Date.now();
  let stdoutChunks = [];
  let stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputLimit = false;
  let timedOut = false;
  let spawnError = null;

  const child = spawnWithTreeKill(process.execPath, [script], {
    cwd: skill.realDir,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv({
      CONDUCTOR_RUN_ID: run.runId,
      CONDUCTOR_SKILL_ID: skill.id,
      CONDUCTOR_ARTIFACT_DIR: artifactDir,
    }),
  });

  const limit = config.execution.maxOutputBytes;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, config.execution.timeoutMs);

  child.stdout.on('data', (chunk) => {
    const result = boundedAppend(stdoutChunks, stdoutBytes, chunk, limit);
    stdoutBytes = result.bytes;
    if (result.over) {
      outputLimit = true;
      killProcessTree(child);
    }
  });
  child.stderr.on('data', (chunk) => {
    const result = boundedAppend(stderrChunks, stderrBytes, chunk, limit);
    stderrBytes = result.bytes;
    if (result.over) {
      outputLimit = true;
      killProcessTree(child);
    }
  });
  child.on('error', (error) => {
    spawnError = error;
  });
  child.stdin.on('error', () => {});
  try {
    child.stdin.end(JSON.stringify(payload), 'utf8');
  } catch {
    // child may have exited immediately
  }

  const outcome = await new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));

  const after = await inventory(artifactDir, {
    maxArtifacts: config.execution.maxArtifacts,
    maxHashBytes: config.execution.maxResourceBytes,
  });
  const artifacts = after.filter((item) => !before.has(item.name));

  let status = 'executed';
  let error = null;
  if (spawnError) {
    status = 'failed';
    error = `spawn failed: ${spawnError.message}`;
  } else if (timedOut) {
    status = 'timeout';
    error = `execution exceeded ${config.execution.timeoutMs}ms and was terminated`;
  } else if (outputLimit) {
    status = 'output_limit';
    error = `output exceeded ${limit} bytes and was terminated`;
  } else if (outcome.code !== 0) {
    status = 'failed';
    error = `script exited with code ${outcome.code}${outcome.signal ? ` (${outcome.signal})` : ''}`;
  }

  return {
    status,
    skillId: skill.id,
    stepId: step.id,
    executable: skill.executable.name,
    script: path.relative(skill.realDir, script).replaceAll(path.sep, '/'),
    exitCode: outcome.code,
    signal: outcome.signal ?? null,
    durationMs: Date.now() - started,
    timedOut,
    outputLimit,
    stdout: config.execution.captureOutput ? redactSecrets(Buffer.concat(stdoutChunks).toString('utf8')) : '',
    stderr: config.execution.captureOutput ? redactSecrets(Buffer.concat(stderrChunks).toString('utf8')) : '',
    artifacts,
    artifactDir,
    ...(error ? { error } : {}),
    startedAt: new Date(started).toISOString(),
    finishedAt: nowIso(),
  };
}

export { inventory as inventoryArtifacts };
