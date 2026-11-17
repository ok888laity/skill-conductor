import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from './errors.mjs';
import { readJson, sha256, stableStringify } from './util.mjs';

export const DEFAULT_OPENCODE_MODEL = 'opencode-go/deepseek-v4.1-flash';

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

function num(value, field, fallback, { min = 0, max = 1 } = {}) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${field} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function stringList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new ConfigError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function safeNamespace(value, fallback) {
  const raw = String(value ?? fallback ?? '').trim();
  if (!raw) throw new ConfigError('root namespace must not be empty');
  if (/[:/\\]/.test(raw)) throw new ConfigError(`root namespace may not contain : / \\ (${raw})`);
  return raw;
}

async function normalizeRoots(rawRoots, baseDir, includeHidden) {
  if (!Array.isArray(rawRoots) || rawRoots.length === 0) {
    throw new ConfigError('roots must be a non-empty array of paths or root objects');
  }
  const roots = [];
  for (let index = 0; index < rawRoots.length; index += 1) {
    const entry = rawRoots[index];
    let item;
    if (typeof entry === 'string') {
      item = { path: entry };
    } else if (isObject(entry)) {
      item = entry;
    } else {
      throw new ConfigError(`roots[${index}] must be a string or object`);
    }
    if (typeof item.path !== 'string' || item.path.trim() === '') {
      throw new ConfigError(`roots[${index}].path must be a non-empty string`);
    }
    const absPath = path.resolve(baseDir, item.path);
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      throw new ConfigError(`root does not exist: ${absPath}`, { root: absPath });
    }
    if (!stat.isDirectory()) throw new ConfigError(`root is not a directory: ${absPath}`, { root: absPath });
    const namespace = safeNamespace(item.namespace, path.basename(absPath) || `root${index + 1}`);
    roots.push({
      path: absPath,
      namespace,
      trusted: bool(item.trusted, `roots[${index}].trusted`, false),
      includeHidden: bool(item.includeHidden, `roots[${index}].includeHidden`, includeHidden),
    });
  }
  const namespaces = new Set();
  for (const root of roots) {
    if (namespaces.has(root.namespace)) {
      throw new ConfigError(`duplicate root namespace: ${root.namespace}; set explicit unique namespaces`);
    }
    namespaces.add(root.namespace);
  }
  return roots;
}

function normalizeSelector(raw = {}) {
  if (!isObject(raw)) throw new ConfigError('selector must be an object');
  const mode = raw.mode ?? 'lexical';
  if (!['lexical', 'http', 'opencode'].includes(mode)) {
    throw new ConfigError('selector.mode must be lexical, http or opencode');
  }
  const selector = {
    mode,
    maxCandidates: int(raw.maxCandidates, 'selector.maxCandidates', 20, { min: 1, max: 200 }),
    minScore: num(raw.minScore, 'selector.minScore', 0.8, { min: 0, max: 1000 }),
    ambiguityGap: num(raw.ambiguityGap, 'selector.ambiguityGap', 0.12, { min: 0, max: 1 }),
    semanticAllThreshold: int(raw.semanticAllThreshold, 'selector.semanticAllThreshold', 40, { min: 1, max: 500 }),
    semanticPrefilterLimit: int(raw.semanticPrefilterLimit, 'selector.semanticPrefilterLimit', 30, {
      min: 1,
      max: 500,
    }),
    maxSelection: int(raw.maxSelection, 'selector.maxSelection', 3, { min: 1, max: 10 }),
    timeoutMs: int(raw.timeoutMs, 'selector.timeoutMs', 60000, { min: 1000, max: 600000 }),
    baseURL: null,
    model: null,
    apiKeyEnv: 'SKILL_CONDUCTOR_API_KEY',
    opencode: {
      cliPath: process.env.SKILL_CONDUCTOR_OPENCODE_CLI || null,
      model: DEFAULT_OPENCODE_MODEL,
      agent: null,
      workdir: null,
      standalone: true,
      archived: true,
    },
  };
  if (raw.baseURL !== undefined) {
    if (typeof raw.baseURL !== 'string' || raw.baseURL.trim() === '') {
      throw new ConfigError('selector.baseURL must be a non-empty string');
    }
    let parsed;
    try {
      parsed = new URL(raw.baseURL);
    } catch {
      throw new ConfigError(`selector.baseURL is not a valid URL: ${raw.baseURL}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ConfigError('selector.baseURL must use http or https');
    }
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol === 'http:' && !loopback) {
      throw new ConfigError('plain http is only allowed for loopback selector.baseURL; use https');
    }
    selector.baseURL = raw.baseURL.replace(/\/+$/, '');
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || raw.model.trim() === '') {
      throw new ConfigError('selector.model must be a non-empty string');
    }
    selector.model = raw.model.trim();
  }
  if (raw.apiKeyEnv !== undefined) {
    if (typeof raw.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.apiKeyEnv)) {
      throw new ConfigError('selector.apiKeyEnv must be an environment variable name');
    }
    selector.apiKeyEnv = raw.apiKeyEnv;
  }
  if (raw.opencode !== undefined) {
    if (!isObject(raw.opencode)) throw new ConfigError('selector.opencode must be an object');
    const oc = raw.opencode;
    if (oc.cliPath !== undefined) {
      if (typeof oc.cliPath !== 'string' || oc.cliPath.trim() === '') {
        throw new ConfigError('selector.opencode.cliPath must be a non-empty string');
      }
      selector.opencode.cliPath = oc.cliPath;
    }
    if (oc.model !== undefined) {
      if (typeof oc.model !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(oc.model)) {
        throw new ConfigError('selector.opencode.model must look like provider/model');
      }
      selector.opencode.model = oc.model;
    }
    if (oc.agent !== undefined) {
      if (typeof oc.agent !== 'string' || oc.agent.trim() === '') {
        throw new ConfigError('selector.opencode.agent must be a non-empty string');
      }
      selector.opencode.agent = oc.agent.trim();
    }
    if (oc.workdir !== undefined) {
      if (typeof oc.workdir !== 'string' || oc.workdir.trim() === '') {
        throw new ConfigError('selector.opencode.workdir must be a non-empty string');
      }
      selector.opencode.workdir = oc.workdir;
    }
    selector.opencode.standalone = bool(oc.standalone, 'selector.opencode.standalone', selector.opencode.standalone);
    selector.opencode.archived = bool(oc.archived, 'selector.opencode.archived', selector.opencode.archived);
  }
  if (mode === 'http') {
    if (!selector.baseURL) throw new ConfigError('selector.mode=http requires selector.baseURL');
    if (!selector.model) throw new ConfigError('selector.mode=http requires selector.model');
  }
  if (mode === 'opencode' && !selector.opencode.cliPath) {
    throw new ConfigError(
      'selector.mode=opencode requires selector.opencode.cliPath (or SKILL_CONDUCTOR_OPENCODE_CLI)',
    );
  }
  return selector;
}

export async function normalizeConfig(raw, { baseDir = process.cwd(), configPath = null } = {}) {
  if (!isObject(raw)) throw new ConfigError('config root must be a JSON object');
  const warnings = [];
  const includeHidden = bool(raw.includeHidden, 'includeHidden', false);
  const roots = await normalizeRoots(raw.roots, baseDir, includeHidden);
  const selector = normalizeSelector(raw.selector ?? {});
  const policyRaw = raw.policy ?? {};
  if (!isObject(policyRaw)) throw new ConfigError('policy must be an object');
  const policyMode = policyRaw.mode ?? 'ask';
  if (!['ask', 'auto'].includes(policyMode)) throw new ConfigError('policy.mode must be ask or auto');

  const capabilities = stringList(raw.capabilities, 'capabilities');

  const executionRaw = raw.execution ?? {};
  if (!isObject(executionRaw)) throw new ConfigError('execution must be an object');
  const runDirRaw = executionRaw.runDir ?? 'runs';
  if (typeof runDirRaw !== 'string' || runDirRaw.trim() === '') {
    throw new ConfigError('execution.runDir must be a non-empty string');
  }
  const execution = {
    enabled: bool(executionRaw.enabled, 'execution.enabled', false),
    allowlist: stringList(executionRaw.allowlist, 'execution.allowlist'),
    trustedSkillIds: stringList(executionRaw.trustedSkillIds, 'execution.trustedSkillIds'),
    timeoutMs: int(executionRaw.timeoutMs, 'execution.timeoutMs', 30000, { min: 100, max: 600000 }),
    maxOutputBytes: int(executionRaw.maxOutputBytes, 'execution.maxOutputBytes', 65536, {
      min: 1024,
      max: 10 * 1024 * 1024,
    }),
    maxArtifacts: int(executionRaw.maxArtifacts, 'execution.maxArtifacts', 50, { min: 1, max: 500 }),
    maxResourceBytes: int(executionRaw.maxResourceBytes, 'execution.maxResourceBytes', 512 * 1024, {
      min: 1024,
      max: 20 * 1024 * 1024,
    }),
    stopOnError: bool(executionRaw.stopOnError, 'execution.stopOnError', true),
    captureOutput: bool(executionRaw.captureOutput, 'execution.captureOutput', true),
    runDir: path.resolve(baseDir, runDirRaw),
  };

  const materialsRaw = raw.materials ?? {};
  if (!isObject(materialsRaw)) throw new ConfigError('materials must be an object');
  const maxFileBytes = int(materialsRaw.maxFileBytes, 'materials.maxFileBytes', 1024 * 1024, {
    min: 1,
    max: 32 * 1024 * 1024,
  });
  const maxTotalBytes = int(materialsRaw.maxTotalBytes, 'materials.maxTotalBytes', 4 * 1024 * 1024, {
    min: 1,
    max: 128 * 1024 * 1024,
  });
  const allowRoots = [];
  if (materialsRaw.allowRoots !== undefined) {
    for (const entry of stringList(materialsRaw.allowRoots, 'materials.allowRoots')) {
      allowRoots.push(path.resolve(baseDir, entry));
    }
  }
  const materials = {
    maxFileBytes,
    maxTotalBytes,
    maxFiles: int(materialsRaw.maxFiles, 'materials.maxFiles', 32, { min: 1, max: 200 }),
    allowRoots,
  };

  const mcpRaw = raw.mcp ?? {};
  if (!isObject(mcpRaw)) throw new ConfigError('mcp must be an object');
  const mcp = {
    allowExecution: bool(mcpRaw.allowExecution, 'mcp.allowExecution', false),
    maxInputBytes: int(mcpRaw.maxInputBytes, 'mcp.maxInputBytes', 1024 * 1024, { min: 1024, max: 16 * 1024 * 1024 }),
  };

  const reviewRaw = raw.review ?? {};
  if (!isObject(reviewRaw)) throw new ConfigError('review must be an object');
  const review = {
    enabled: bool(reviewRaw.enabled, 'review.enabled', false),
    host: reviewRaw.host ?? '127.0.0.1',
    port: int(reviewRaw.port, 'review.port', 0, { min: 0, max: 65535 }),
  };
  if (review.host !== '127.0.0.1' && review.host !== '::1' && review.host !== 'localhost') {
    throw new ConfigError('review.host must be a loopback address (127.0.0.1, ::1 or localhost)');
  }

  const known = new Set([
    'roots',
    'includeHidden',
    'selector',
    'policy',
    'capabilities',
    'execution',
    'materials',
    'mcp',
    'review',
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) warnings.push(`unknown config key ignored: ${key}`);
  }

  const config = {
    version: '0.1',
    configPath,
    baseDir,
    roots,
    includeHidden,
    selector,
    policy: { mode: policyMode },
    capabilities,
    execution,
    materials,
    mcp,
    review,
    warnings,
  };
  config.fingerprint = configFingerprint(config);
  return config;
}

/**
 * Find a project-local config without reading any global location. Explicit
 * --config always wins; this is only the fallback for installed commands.
 * The search walks from the working directory toward the filesystem root.
 */
export async function discoverConfigPath(startDir = process.cwd()) {
  const candidates = ['.skill-conductor/config.json', 'skill-conductor.config.json'];
  let current = path.resolve(startDir);
  for (;;) {
    for (const relative of candidates) {
      const file = path.join(current, relative);
      try {
        const stat = await fs.stat(file);
        if (stat.isFile()) return file;
      } catch {
        // keep looking
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function loadConfig(configPath, { cwd = process.cwd() } = {}) {
  if (typeof configPath !== 'string' || configPath.trim() === '') {
    throw new ConfigError('config path is required (--config PATH)');
  }
  const absPath = path.resolve(cwd, configPath);
  let raw;
  try {
    raw = await readJson(absPath, { maxBytes: 2 * 1024 * 1024 });
  } catch (error) {
    throw new ConfigError(`cannot read config ${absPath}: ${error.message}`, { configPath: absPath });
  }
  return normalizeConfig(raw, { baseDir: path.dirname(absPath), configPath: absPath });
}

/** Only non-secret configuration is reported. API keys are referenced by env name. */
export function publicConfig(config) {
  return {
    configPath: config.configPath,
    roots: config.roots.map((root) => ({
      path: root.path,
      namespace: root.namespace,
      trusted: root.trusted,
      includeHidden: root.includeHidden,
    })),
    selector: {
      mode: config.selector.mode,
      maxCandidates: config.selector.maxCandidates,
      minScore: config.selector.minScore,
      ambiguityGap: config.selector.ambiguityGap,
      semanticAllThreshold: config.selector.semanticAllThreshold,
      maxSelection: config.selector.maxSelection,
      timeoutMs: config.selector.timeoutMs,
      baseURL: config.selector.baseURL,
      model: config.selector.model,
      apiKeyEnv: config.selector.apiKeyEnv,
      opencode: {
        cliPath: config.selector.opencode.cliPath,
        model: config.selector.opencode.model,
        agent: config.selector.opencode.agent,
        standalone: config.selector.opencode.standalone,
        archived: config.selector.opencode.archived,
      },
    },
    policy: config.policy,
    capabilities: config.capabilities,
    execution: {
      enabled: config.execution.enabled,
      allowlist: config.execution.allowlist,
      trustedSkillIds: config.execution.trustedSkillIds,
      timeoutMs: config.execution.timeoutMs,
      maxOutputBytes: config.execution.maxOutputBytes,
      runDir: config.execution.runDir,
    },
    materials: config.materials,
    mcp: config.mcp,
    review: config.review,
    warnings: config.warnings,
  };
}

export function configFingerprint(config) {
  return sha256(
    stableStringify({
      schema: 'skill-conductor/config/v0.2',
      roots: config.roots.map((root) => [root.path, root.namespace, root.trusted]),
      capabilities: config.capabilities,
      policy: { mode: config.policy?.mode ?? 'ask' },
      execution: {
        enabled: config.execution?.enabled ?? false,
        allowlist: config.execution?.allowlist ?? [],
        trustedSkillIds: config.execution?.trustedSkillIds ?? [],
        timeoutMs: config.execution?.timeoutMs ?? null,
        maxOutputBytes: config.execution?.maxOutputBytes ?? null,
        maxArtifacts: config.execution?.maxArtifacts ?? null,
        maxResourceBytes: config.execution?.maxResourceBytes ?? null,
        stopOnError: config.execution?.stopOnError ?? null,
        captureOutput: config.execution?.captureOutput ?? null,
        runDir: config.execution?.runDir ?? null,
      },
      mcp: { allowExecution: config.mcp?.allowExecution ?? false },
    }),
  );
}
