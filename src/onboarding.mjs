import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCatalog, catalogSummary } from './catalog.mjs';
import { discoverConfigPath, loadConfig, normalizeConfig } from './config.mjs';
import { ConfigError } from './errors.mjs';
import { isInside, posix } from './util.mjs';

export const PRODUCT_VERSION = '0.3.0';
export const SETUP_SCHEMA = 'skill-conductor/setup/v1';
export const SETUP_MARKER = 'skill-conductor';
export const MIN_NODE_VERSION = '20.11.0';

export const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const HOST_ALIASES = new Map([
  ['cursor', 'cursor'],
  ['cusor', 'cursor'],
  ['qoder', 'qoder'],
  ['qorde', 'qoder'],
  ['workbuddy', 'workbuddy'],
  ['codebuddy', 'workbuddy'],
  ['deepseek-harness', 'deepseek-harness'],
  ['deepseekharness', 'deepseek-harness'],
  ['deepseek_harness', 'deepseek-harness'],
  ['dsh', 'deepseek-harness'],
  ['opencode', 'opencode'],
  ['generic', 'generic'],
]);

export function normalizeHostName(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const normalized = String(value).trim().toLowerCase();
  const host = HOST_ALIASES.get(normalized);
  if (!host) {
    throw new ConfigError(
      `unsupported host: ${value}; use cursor, workbuddy, qoder, deepseek-harness, opencode or generic`,
    );
  }
  return host;
}

export const HOST_LABELS = {
  cursor: 'Cursor',
  workbuddy: 'WorkBuddy',
  qoder: 'Qoder',
  'deepseek-harness': 'DeepSeek Harness (Cordis/DSH)',
  opencode: 'OpenCode',
  generic: 'Generic MCP stdio host / SDK',
};

function homeDirOf(options = {}) {
  const env = options.env ?? process.env;
  const value =
    options.homeDir ??
    env.SKILL_CONDUCTOR_HOME ??
    (typeof os.homedir === 'function' ? os.homedir() : '');
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError('cannot determine the user home directory; pass --home PATH');
  }
  return path.resolve(value);
}

function candidate(host, scope, absPath, namespace, declaredPath) {
  return {
    host,
    scope,
    path: path.resolve(absPath),
    namespace,
    declaredPath: declaredPath ?? absPath,
  };
}

function hostDescriptors(homeDir, env) {
  const dshHome = env.DSH_HOME ? path.resolve(env.DSH_HOME) : null;
  const dshAgents = env.DSH_AGENTS_HOME ? path.resolve(env.DSH_AGENTS_HOME) : null;
  // Keep fake-home tests isolated: APPDATA belongs to the selected home only.
  const appDataRaw = env.APPDATA ? path.resolve(env.APPDATA) : null;
  const appData = appDataRaw && isInside(homeDir, appDataRaw) ? appDataRaw : null;
  const candidates = [];

  candidates.push(candidate('cursor', 'project', path.join('REPLACED_CWD', '.cursor', 'skills'), 'cursor', '.cursor/skills'));
  candidates.push(candidate('cursor', 'user', path.join(homeDir, '.cursor', 'skills'), 'cursor', '~/.cursor/skills'));

  candidates.push(candidate('workbuddy', 'project', path.join('REPLACED_CWD', '.workbuddy', 'skills'), 'workbuddy', '.workbuddy/skills'));
  candidates.push(candidate('workbuddy', 'user', path.join(homeDir, '.workbuddy', 'skills'), 'workbuddy', '~/.workbuddy/skills'));
  candidates.push(candidate('workbuddy', 'project', path.join('REPLACED_CWD', '.codebuddy', 'skills'), 'codebuddy', '.codebuddy/skills'));
  candidates.push(candidate('workbuddy', 'user', path.join(homeDir, '.codebuddy', 'skills'), 'codebuddy', '~/.codebuddy/skills'));

  candidates.push(candidate('qoder', 'project', path.join('REPLACED_CWD', '.qoder', 'skills'), 'qoder', '.qoder/skills'));
  candidates.push(candidate('qoder', 'user', path.join(homeDir, '.qoder', 'skills'), 'qoder', '~/.qoder/skills'));

  candidates.push(candidate('deepseek-harness', 'project', path.join('REPLACED_CWD', '.dsh', 'skills'), 'dsh', '.dsh/skills'));
  if (dshHome) {
    candidates.push(candidate('deepseek-harness', 'user', path.join(dshHome, 'skills'), 'dsh', '$DSH_HOME/skills'));
  } else {
    candidates.push(candidate('deepseek-harness', 'user', path.join(homeDir, '.dsh', 'skills'), 'dsh', '~/.dsh/skills'));
  }
  if (dshAgents) {
    candidates.push(candidate('deepseek-harness', 'user', path.join(dshAgents, 'skills'), 'agents-dsh', '$DSH_AGENTS_HOME/skills'));
  }

  candidates.push(candidate('opencode', 'project', path.join('REPLACED_CWD', '.opencode', 'skills'), 'opencode', '.opencode/skills'));
  candidates.push(candidate('opencode', 'user', path.join(homeDir, '.config', 'opencode', 'skills'), 'opencode', '~/.config/opencode/skills'));
  candidates.push(candidate('opencode', 'user', path.join(homeDir, '.opencode', 'skills'), 'opencode-alt', '~/.opencode/skills'));
  if (appData) {
    candidates.push(candidate('opencode', 'user', path.join(appData, 'opencode', 'skills'), 'opencode-appdata', '%APPDATA%/opencode/skills'));
  }

  candidates.push(candidate('claude', 'project', path.join('REPLACED_CWD', '.claude', 'skills'), 'claude', '.claude/skills'));
  candidates.push(candidate('claude', 'user', path.join(homeDir, '.claude', 'skills'), 'claude', '~/.claude/skills'));

  candidates.push(candidate('codex', 'project', path.join('REPLACED_CWD', '.codex', 'skills'), 'codex', '.codex/skills'));
  candidates.push(candidate('codex', 'user', path.join(homeDir, '.codex', 'skills'), 'codex', '~/.codex/skills'));

  candidates.push(candidate('agents', 'project', path.join('REPLACED_CWD', '.agents', 'skills'), 'agents', '.agents/skills'));
  candidates.push(candidate('agents', 'user', path.join(homeDir, '.agents', 'skills'), 'agents', '~/.agents/skills'));

  candidates.push(candidate('generic', 'project', path.join('REPLACED_CWD', 'skills'), 'project', 'skills'));
  return candidates;
}

async function statDir(dir) {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function realDir(dir) {
  try {
    const real = await fs.realpath(dir);
    return (await fs.stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Bounded metadata-only search for Codex plugin skill roots. It never scans a
 * whole disk and never reads or runs skill scripts. Only directories named
 * "skills" under the plugin cache are returned.
 */
async function codexPluginRoots(cacheDir, issues) {
  if (!(await statDir(cacheDir))) return [];
  const cacheReal = await realDir(cacheDir);
  if (!cacheReal) return [];
  const found = [];
  let visited = 0;
  const queue = [{ dir: cacheReal, depth: 0, rel: '' }];
  while (queue.length > 0 && visited < 300 && found.length < 50) {
    const current = queue.shift();
    visited += 1;
    if (current.depth > 5) continue;
    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch (error) {
      issues.push(`cannot read Codex plugin directory ${current.dir}: ${error.message}`);
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const child = path.join(current.dir, entry.name);
      let childReal;
      try {
        childReal = await fs.realpath(child);
        if (!(await fs.stat(childReal)).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!isInside(cacheReal, childReal)) {
        issues.push(`skipped Codex plugin symlink outside cache: ${child}`);
        continue;
      }
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.name === 'skills') {
        found.push({ dir: childReal, rel });
        continue;
      }
      queue.push({ dir: childReal, depth: current.depth + 1, rel });
    }
  }
  return found;
}

function slug(value) {
  const text = String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return text || 'plugin';
}

async function hiddenSkillNeeded(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let checked = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.')) continue;
    if (entry.name === '.git' || entry.name === '.svn') continue;
    checked += 1;
    if (checked > 20) break;
    const hidden = path.join(dir, entry.name);
    if (await statFile(path.join(hidden, 'SKILL.md'))) return true;
    let children;
    try {
      children = await fs.readdir(hidden, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children.slice(0, 50)) {
      if (child.isDirectory() && (await statFile(path.join(hidden, child.name, 'SKILL.md')))) return true;
    }
  }
  return false;
}

async function statFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

function priorityFor(candidateRoot, selectedHost) {
  const selected = candidateRoot.host === selectedHost;
  if (selected) return candidateRoot.scope === 'project' ? 10 : 11;
  if (candidateRoot.host === 'agents') return candidateRoot.scope === 'project' ? 20 : 21;
  if (candidateRoot.scope === 'project') return 30;
  return 40;
}

function uniqueNamespace(base, used) {
  let value = base;
  let index = 2;
  while (used.has(value)) {
    value = `${base}-${index}`;
    index += 1;
  }
  used.add(value);
  return value;
}

function normalizedRootSource(source) {
  if (!source) return null;
  return {
    kind: source.kind,
    ...(source.host ? { host: source.host } : {}),
    ...(source.scope ? { scope: source.scope } : {}),
    ...(source.declaredPath ? { declaredPath: source.declaredPath } : {}),
  };
}

/**
 * Discover only known user/project skill roots. No whole-disk scan, no skill
 * installation, no script execution and no automatic trust.
 */
export async function discoverUserRoots({
  cwd = process.cwd(),
  homeDir = null,
  env = process.env,
  host = null,
  extraRoots = [],
  includeHidden = false,
} = {}) {
  const selectedHost = normalizeHostName(host);
  const home = homeDir ? path.resolve(homeDir) : homeDirOf({ homeDir, env });
  const project = path.resolve(cwd);
  const issues = [];
  const generated = hostDescriptors(home, env).map((entry) => ({
    ...entry,
    path: entry.scope === 'project' ? path.resolve(project, entry.declaredPath) : entry.path,
  }));

  const codexCache = path.join(home, '.codex', 'plugins', 'cache');
  for (const plugin of await codexPluginRoots(codexCache, issues)) {
    generated.push({
      host: 'codex',
      scope: 'user',
      path: plugin.dir,
      namespace: `codex-plugin-${slug(plugin.rel.replace(/\/skills$/, ''))}`,
      declaredPath: `~/.codex/plugins/cache/${plugin.rel}`,
    });
  }

  generated.sort((a, b) => {
    const byPriority = priorityFor(a, selectedHost) - priorityFor(b, selectedHost);
    if (byPriority !== 0) return byPriority;
    const byHost = a.host.localeCompare(b.host);
    if (byHost !== 0) return byHost;
    const byScope = a.scope.localeCompare(b.scope);
    if (byScope !== 0) return byScope;
    return a.path.localeCompare(b.path);
  });

  // Exclude project state and the bundled demo tree only. Do not exclude the
  // whole source checkout in development: a project's own .claude/skills etc.
  // must still be discoverable when cwd is the source checkout.
  const exclusions = [
    path.join(project, '.skill-conductor'),
    path.join(productRoot, 'skills'),
    path.join(productRoot, 'data'),
    path.join(productRoot, 'examples'),
  ];
  const seen = new Set();
  const usedNamespaces = new Set();
  const roots = [];
  const skipped = [];

  for (const entry of generated) {
    const real = await realDir(entry.path);
    if (!real) continue;
    if (seen.has(real)) {
      skipped.push({ path: real, reason: 'duplicate real path', declaredPath: entry.declaredPath });
      continue;
    }
    if (exclusions.some((excluded) => isInside(path.resolve(excluded), real))) {
      skipped.push({
        path: real,
        reason: 'internal installation/demo scaffold is excluded from the default user catalog',
        declaredPath: entry.declaredPath,
      });
      continue;
    }
    seen.add(real);
    const needsHidden = includeHidden || (await hiddenSkillNeeded(real));
    roots.push({
      path: real,
      namespace: uniqueNamespace(`${entry.namespace}-${entry.scope}`, usedNamespaces),
      trusted: false,
      includeHidden: needsHidden,
      source: {
        kind: 'discovered',
        host: entry.host,
        scope: entry.scope,
        declaredPath: entry.declaredPath,
      },
    });
  }

  for (const [index, extra] of [...extraRoots].entries()) {
    if (typeof extra !== 'string' || extra.trim() === '') {
      throw new ConfigError('--root must be a non-empty directory path');
    }
    const abs = path.resolve(project, extra);
    const real = await realDir(abs);
    if (!real) throw new ConfigError(`--root does not exist or is not a directory: ${abs}`);
    if (seen.has(real)) {
      skipped.push({ path: real, reason: 'duplicate real path (explicit --root)', declaredPath: abs });
      continue;
    }
    seen.add(real);
    roots.push({
      path: real,
      namespace: uniqueNamespace(`explicit${index === 0 ? '' : `-${index + 1}`}`, usedNamespaces),
      trusted: false,
      includeHidden: Boolean(includeHidden),
      source: { kind: 'explicit', declaredPath: abs },
    });
  }

  return {
    roots,
    skipped,
    issues,
    selectedHost,
    homeDir: home,
    discovery: {
      schema: 'skill-conductor/discovery/v1',
      strategy: 'known project/user roots only; no whole-disk scan',
      selectedHost,
      includeHidden: Boolean(includeHidden),
      examined: generated.length,
    },
  };
}

async function readRootEntries(raw, baseDir) {
  if (!Array.isArray(raw.roots)) {
    if (raw.roots === undefined) return [];
    throw new ConfigError('roots must be an array');
  }
  const entries = [];
  for (const [index, item] of raw.roots.entries()) {
    let value;
    if (typeof item === 'string') value = { path: item };
    else if (isObject(item)) value = item;
    else throw new ConfigError(`roots[${index}] must be a string or object`);
    if (typeof value.path !== 'string' || value.path.trim() === '') {
      throw new ConfigError(`roots[${index}].path must be a non-empty string`);
    }
    const abs = path.resolve(baseDir, value.path);
    let real = null;
    try {
      real = await fs.realpath(abs);
    } catch {
      real = null;
    }
    entries.push({
      path: abs,
      realPath: real,
      namespace: typeof value.namespace === 'string' ? value.namespace : null,
      trusted: value.trusted === true,
      includeHidden: value.includeHidden === true,
      source: normalizedRootSource(value.source),
    });
  }
  return entries;
}

async function resolveRootReal(entry) {
  if (entry.realPath) return entry.realPath;
  try {
    const real = await fs.realpath(entry.path);
    return (await fs.stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function insideDemoScaffold(entry, baseDir) {
  if (!entry.realPath) return false;
  return (
    entry.source?.kind === 'demo' ||
    entry.namespace === 'demo' ||
    isInside(path.join(baseDir, 'demo'), entry.realPath)
  );
}

function defaultSetupSection(existing, context) {
  return {
    ...(isObject(existing) ? existing : {}),
    managedBy: SETUP_MARKER,
    schema: SETUP_SCHEMA,
    version: PRODUCT_VERSION,
    rootsMode: context.rootsMode,
    lastHost: context.host ?? null,
    updatedAt: context.updatedAt,
  };
}

function portableRootPath(baseDir, target) {
  const project = path.dirname(baseDir);
  const rel = path.relative(baseDir, target);
  if (isInside(project, target)) return rel.startsWith('..') ? posix(rel) : `./${posix(rel)}`;
  return posix(target);
}

function rawRootFor(baseDir, root) {
  return {
    path: portableRootPath(baseDir, root.path),
    namespace: root.namespace,
    trusted: Boolean(root.trusted),
    includeHidden: Boolean(root.includeHidden),
    ...(root.source ? { source: root.source } : {}),
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(temp, file);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES') {
      await fs.unlink(file).catch(() => {});
      await fs.rename(temp, file);
    } else {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  }
}

async function backupConfig(configPath, originalText, now) {
  const dir = path.join(path.dirname(configPath), 'backups');
  await fs.mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const target = path.join(dir, `config-${stamp}${suffix}.json`);
    try {
      await fs.writeFile(target, originalText, { encoding: 'utf8', flag: 'wx' });
      return target;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new ConfigError('could not create a unique config backup name');
}

export function looksLikeDemoScaffold(raw, configPath) {
  if (!isObject(raw) || !Array.isArray(raw.roots) || raw.roots.length === 0) return false;
  const baseDir = path.dirname(path.resolve(configPath));
  const demoPrefix = path.join(baseDir, 'demo');
  let allDemoRoots = true;
  for (const entry of raw.roots) {
    const value = typeof entry === 'string' ? { path: entry } : isObject(entry) ? entry : null;
    if (!value || typeof value.path !== 'string') return false;
    const abs = path.resolve(baseDir, value.path);
    const inDemoText = abs === demoPrefix || isInside(demoPrefix, abs);
    if (!inDemoText && value.namespace !== 'demo') allDemoRoots = false;
  }
  if (!allDemoRoots) return false;
  const trusted = raw.execution?.trustedSkillIds;
  return Array.isArray(trusted) && trusted.length > 0 && trusted.every((id) => String(id).startsWith('demo:'));
}

function filterDemoTrust(execution, demoScaffold) {
  if (!isObject(execution)) return execution;
  const filter = (list) =>
    Array.isArray(list) ? list.filter((id) => typeof id === 'string' && !id.startsWith('demo:')) : list;
  const next = { ...execution };
  next.allowlist = filter(execution.allowlist);
  next.trustedSkillIds = filter(execution.trustedSkillIds);
  if (demoScaffold && next.trustedSkillIds?.length === 0 && execution.enabled === true) {
    next.enabled = false;
  }
  return next;
}

function rootCountsByNamespace(catalog) {
  const counts = new Map();
  for (const skill of catalog.skills) counts.set(skill.namespace, (counts.get(skill.namespace) ?? 0) + 1);
  return counts;
}

function catalogStatus(catalog) {
  if (catalog.counts.skills === 0) return 'no_user_skills';
  if (catalog.counts.valid === 0) return 'no_valid_user_skills';
  return 'ready';
}

function statusNextAction(status, setupStatus) {
  if (status === 'no_user_skills') {
    return 'No existing user skills were found. Create a SKILL.md under .agents/skills, .claude/skills, .cursor/skills or another detected host root, or pass --root PATH; no demo was installed.';
  }
  if (status === 'no_valid_user_skills') {
    return 'Skill files were found but none has a usable name/valid frontmatter. Fix those SKILL.md files or inspect them with "skill-conductor list".';
  }
  if (setupStatus === 'existing_custom_config_preserved') {
    return 'An existing custom config was preserved. Add roots with your editor or move this config aside and rerun setup if you want rediscovery.';
  }
  if (setupStatus === 'existing_custom_config_invalid') {
    return 'The existing custom config is invalid and was not modified. Fix it or back it up and rerun setup.';
  }
  return null;
}

function setupRootReport(roots, catalog) {
  const counts = rootCountsByNamespace(catalog);
  return roots.map((root) => ({
    path: root.path,
    namespace: root.namespace,
    trusted: Boolean(root.trusted),
    includeHidden: Boolean(root.includeHidden),
    source: root.source ?? null,
    skills: counts.get(root.namespace) ?? 0,
  }));
}

async function buildReport({ config, catalog, setupStatus, changed, created, backupPath, migration, rootsExtra, cwd }) {
  const status = catalogStatus(catalog);
  const demoDir = path.join(cwd ?? config.baseDir, '.skill-conductor', 'demo');
  const demoInstalled = await fs
    .stat(demoDir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  return {
    ok: true,
    command: 'setup',
    version: PRODUCT_VERSION,
    setupStatus,
    status,
    readyForRealTasks: status === 'ready',
    changed,
    created,
    configPath: config.configPath,
    config: {
      version: config.version,
      managed: config.setup?.managedBy === SETUP_MARKER,
      rootsMode: config.setup?.rootsMode ?? null,
      policy: config.policy,
      assistance: config.assistance,
      execution: {
        enabled: config.execution.enabled,
        trustedSkillCount: config.execution.trustedSkillIds.length,
      },
    },
    runtime: {
      status: 'ready',
      node: process.versions.node,
      executable: process.execPath,
      platform: process.platform,
      arch: process.arch,
      minimum: MIN_NODE_VERSION,
    },
    roots: setupRootReport(config.roots, catalog),
    catalog: {
      status,
      counts: catalog.counts,
      catalogHash: catalog.catalogHash,
    },
    demo: {
      installed: demoInstalled,
      routed: config.roots.some((root) => root.source?.kind === 'demo' || root.namespace === 'demo'),
      includedInUserCatalog: false,
      note: 'The bundled demo is never a default user root.',
    },
    backupPath: backupPath ?? null,
    migration: migration ?? null,
    nextAction: statusNextAction(status, setupStatus),
    ...(rootsExtra ?? {}),
  };
}

/**
 * Idempotent owner setup. It creates a local config when missing, extends a
 * setup-managed config, migrates only the recognized demo-only scaffold, and
 * leaves unknown/custom configs untouched. It never installs a skill or trusts
 * discovered roots.
 */
export async function applySetup({
  cwd = process.cwd(),
  homeDir = null,
  env = process.env,
  host = null,
  extraRoots = [],
  configPath = null,
  includeHidden = false,
  now = new Date(),
} = {}) {
  const project = path.resolve(cwd);
  const selectedHost = normalizeHostName(host);
  const discovered = await discoverUserRoots({
    cwd: project,
    homeDir,
    env,
    host: selectedHost,
    extraRoots,
    includeHidden,
  });
  const targetPath = configPath
    ? path.resolve(project, configPath)
    : (await discoverConfigPath(project)) ?? path.join(project, '.skill-conductor', 'config.json');
  const baseDir = path.dirname(targetPath);
  const existed = await fs
    .stat(targetPath)
    .then((stat) => stat.isFile())
    .catch(() => false);
  let originalText = null;
  let raw = null;
  if (existed) {
    try {
      const stat = await fs.stat(targetPath);
      if (stat.size > 2 * 1024 * 1024) throw new Error('config exceeds 2 MiB');
      originalText = await fs.readFile(targetPath, 'utf8');
      raw = JSON.parse(originalText.replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new ConfigError(`cannot read existing config ${targetPath}: ${error.message}`, {
        configPath: targetPath,
      });
    }
  }

  const managed = raw?.setup?.managedBy === SETUP_MARKER;
  const demoScaffold = raw ? looksLikeDemoScaffold(raw, targetPath) : false;

  if (raw && !managed && !demoScaffold) {
    let config;
    let catalog;
    try {
      config = await loadConfig(targetPath, { cwd: project });
      catalog = await discoverCatalog(config);
    } catch (error) {
      return {
        ok: false,
        command: 'setup',
        version: PRODUCT_VERSION,
        setupStatus: 'existing_custom_config_invalid',
        status: 'config_invalid',
        readyForRealTasks: false,
        changed: false,
        created: false,
        configPath: targetPath,
        error: { code: error.code ?? 'config_error', message: error.message },
        runtime: {
          status: 'ready',
          node: process.versions.node,
          executable: process.execPath,
          platform: process.platform,
          arch: process.arch,
          minimum: MIN_NODE_VERSION,
        },
        nextAction: statusNextAction('config_invalid', 'existing_custom_config_invalid'),
      };
    }
    return {
      ...(await buildReport({
        config,
        catalog,
        setupStatus: 'existing_custom_config_preserved',
        changed: false,
        created: false,
        cwd: project,
      })),
      rootDiscovery: discovered,
    };
  }

  const existingRoots = raw ? await readRootEntries(raw, baseDir) : [];
  const seen = new Set();
  const usedNamespaces = new Set();
  const merged = [];

  for (const root of discovered.roots) {
    if (seen.has(root.path)) continue;
    const existing = existingRoots.find((entry) => entry.realPath === root.path);
    if (existing) {
      seen.add(root.path);
      merged.push({
        path: root.path,
        namespace: existing.namespace ?? root.namespace,
        trusted: existing.trusted,
        includeHidden: existing.includeHidden || root.includeHidden,
        source:
          existing.source?.kind === 'discovered' || existing.source === null
            ? root.source
            : existing.source,
      });
    } else {
      seen.add(root.path);
      merged.push(root);
    }
  }

  if (raw) {
    for (const entry of existingRoots) {
      if (entry.source?.kind === 'discovered') continue;
      if (insideDemoScaffold(entry, baseDir)) continue;
      const real = await resolveRootReal(entry);
      if (!real) {
        throw new ConfigError(
          `existing non-discovered root is not a directory: ${entry.path}; setup will not remove it silently`,
          { root: entry.path },
        );
      }
      if (seen.has(real)) continue;
      seen.add(real);
      merged.push({
        path: real,
        namespace: entry.namespace ?? path.basename(real),
        trusted: entry.trusted,
        includeHidden: entry.includeHidden,
        source: entry.source ?? { kind: 'preserved' },
      });
    }
  }

  for (const [index, root] of merged.entries()) {
    if (!root.namespace) root.namespace = `root-${index + 1}`;
    if (usedNamespaces.has(root.namespace)) {
      if (root.source?.kind === 'discovered' || root.source?.kind === 'explicit') {
        root.namespace = uniqueNamespace(root.namespace, usedNamespaces);
      } else {
        throw new ConfigError(`duplicate root namespace in existing config: ${root.namespace}`);
      }
    } else {
      usedNamespaces.add(root.namespace);
    }
  }

  const hasPreserved = merged.some((root) => root.source?.kind !== 'discovered');
  const next = raw ? JSON.parse(JSON.stringify(raw)) : {};
  next.roots = merged.map((root) => rawRootFor(baseDir, root));
  if (next.includeHidden === undefined) next.includeHidden = Boolean(includeHidden);
  if (!isObject(next.selector)) next.selector = { mode: 'lexical' };
  if (!isObject(next.policy)) next.policy = { mode: 'ask' };
  if (!Array.isArray(next.capabilities)) next.capabilities = [];
  if (!isObject(next.assistance)) next.assistance = { enabled: true, profile: 'balanced' };
  if (!isObject(next.execution)) next.execution = { enabled: false, allowlist: [], trustedSkillIds: [], runDir: './runs' };
  next.execution = filterDemoTrust(next.execution, demoScaffold);
  if (demoScaffold) {
    if (!isObject(next.materials)) next.materials = {};
    next.materials.allowRoots = ['..'];
  } else if (!isObject(next.materials)) {
    next.materials = { allowRoots: ['..'] };
  }
  if (!isObject(next.mcp)) next.mcp = { allowExecution: false };
  next.setup = defaultSetupSection(raw?.setup, {
    rootsMode: hasPreserved ? 'discovered+explicit' : 'discovered',
    host: selectedHost,
    updatedAt: now.toISOString(),
  });

  // Timestamp-only churn must not rewrite the config or create endless backups.
  const comparable = (value) => {
    if (!isObject(value)) return value;
    const clone = JSON.parse(JSON.stringify(value));
    if (clone.setup && typeof clone.setup === 'object') delete clone.setup.updatedAt;
    return clone;
  };
  const semanticChanged = raw === null || stableStringify(comparable(next)) !== stableStringify(comparable(raw));
  if (!semanticChanged && raw?.setup?.updatedAt && next.setup) next.setup.updatedAt = raw.setup.updatedAt;

  const config = await normalizeConfig(next, { baseDir, configPath: targetPath });
  const catalog = await discoverCatalog(config);
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  const exactUnchanged = originalText === nextText;
  let backupPath = null;

  if (semanticChanged && !exactUnchanged) {
    if (existed) backupPath = await backupConfig(targetPath, originalText, now);
    await writeJsonAtomic(targetPath, next);
  }

  const statePath = path.join(baseDir, 'setup.json');
  const state = {
    schema: SETUP_SCHEMA,
    product: 'skill-conductor',
    version: PRODUCT_VERSION,
    updatedAt: now.toISOString(),
    configPath: targetPath,
    host: selectedHost,
    setupStatus: demoScaffold
      ? 'migrated_demo_scaffold'
      : managed
        ? semanticChanged
          ? 'updated'
          : 'already_configured'
        : 'created',
    roots: setupRootReport(config.roots, catalog),
    catalog: {
      status: catalogStatus(catalog),
      counts: catalog.counts,
      catalogHash: catalog.catalogHash,
    },
    discovery: {
      strategy: discovered.discovery.strategy,
      examined: discovered.discovery.examined,
      skipped: discovered.skipped,
      issues: discovered.issues,
    },
    migration: demoScaffold
      ? {
          from: 'owned demo-only scaffold',
          demoFilesPreserved: true,
          demoTrustRemoved: true,
          backupPath,
        }
      : null,
    noUserSkills: catalog.counts.skills === 0,
    demoIncluded: false,
  };
  await writeJsonAtomic(statePath, state);

  const report = await buildReport({
    config,
    catalog,
    setupStatus: demoScaffold
      ? 'migrated_demo_scaffold'
      : existed
        ? semanticChanged
          ? 'updated'
          : 'already_configured'
        : 'created',
    changed: semanticChanged && !exactUnchanged,
    created: !existed,
    backupPath,
    migration: demoScaffold
      ? { from: 'owned demo-only scaffold', demoFilesPreserved: true, demoTrustRemoved: true }
      : null,
    cwd: project,
  });
  report.rootDiscovery = {
    examined: discovered.discovery.examined,
    skipped: discovered.skipped,
    issues: discovered.issues,
    selectedHost: discovered.selectedHost,
  };
  report.setupStatePath = statePath;
  return report;
}

export function readSetupState(configPath) {
  if (!configPath) return null;
  const file = path.join(path.dirname(configPath), 'setup.json');
  return fs
    .readFile(file, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null);
}

function runtimeStatus() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supported = major > 20 || (major === 20 && minor >= 11);
  return {
    status: supported ? 'ready' : 'unsupported',
    node: process.versions.node,
    executable: process.execPath,
    platform: process.platform,
    arch: process.arch,
    minimum: MIN_NODE_VERSION,
  };
}

/**
 * Read-only health/inventory report used by `doctor` and MCP `health`. It never
 * starts a demo, activates a skill or executes a skill script.
 */
export async function doctorReport({ config, cwd = process.cwd(), state = null } = {}) {
  const catalog = await discoverCatalog(config);
  const status = catalogStatus(catalog);
  const setupState = state ?? (await readSetupState(config.configPath));
  const demoDir = path.join(cwd, '.skill-conductor', 'demo');
  const demoInstalled = await fs
    .stat(demoDir)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
  return {
    ok: true,
    command: 'doctor',
    version: PRODUCT_VERSION,
    status,
    readyForRealTasks: status === 'ready',
    runtime: runtimeStatus(),
    config: {
      path: config.configPath,
      managed: config.setup?.managedBy === SETUP_MARKER,
      rootsMode: config.setup?.rootsMode ?? null,
      policy: config.policy,
      assistance: config.assistance,
      selector: { mode: config.selector.mode, label: config.selector.mode },
      execution: {
        enabled: config.execution.enabled,
        trustedSkillCount: config.execution.trustedSkillIds.length,
      },
    },
    roots: setupRootReport(config.roots, catalog),
    catalog: {
      status,
      counts: catalog.counts,
      catalogHash: catalog.catalogHash,
    },
    demo: {
      installed: demoInstalled,
      routed: config.roots.some((root) => root.source?.kind === 'demo' || root.namespace === 'demo'),
      includedInUserCatalog: false,
    },
    setupState,
    nextAction: statusNextAction(status, setupState?.setupStatus),
  };
}

export async function catalogHealth(config) {
  const catalog = await discoverCatalog(config);
  return {
    summary: catalogSummary(catalog, { includeIssues: true }),
    status: catalogStatus(catalog),
    readyForRealTasks: catalog.counts.valid > 0,
  };
}


