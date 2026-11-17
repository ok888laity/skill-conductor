import fs from 'node:fs/promises';
import path from 'node:path';
import { CatalogError } from './errors.mjs';
import { normalizeStringList, parseFrontmatter } from './frontmatter.mjs';
import {
  decodeUtf8,
  isInside,
  posix,
  readJson,
  resolveWithin,
  sha256,
  sha256File,
  stableStringify,
} from './util.mjs';

const SKILL_FILE = 'SKILL.md';
const SIDECAR_FILE = 'conductor.json';
const MAX_SKILL_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_DIRS = 5000;
const MAX_SKILLS = 2000;
const DEFAULT_SKIP = new Set(['.git', 'node_modules']);

function issue(severity, code, message, extra = {}) {
  return { severity, code, message, ...extra };
}

function validateRelativeReference(reference, field) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (path.isAbsolute(reference) || /^[A-Za-z]:/.test(reference) || reference.startsWith('\\\\')) {
    throw new Error(`${field} must be relative: ${reference}`);
  }
  const normalized = reference.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => part === '..')) {
    throw new Error(`${field} may not contain ..: ${reference}`);
  }
  return reference;
}

function parseSidecar(raw, { sidecarPath }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('conductor.json must contain a JSON object');
  }
  const warnings = [];
  const known = new Set([
    'triggers',
    'avoidTriggers',
    'tags',
    'requiredCapabilities',
    'dependencies',
    'conflicts',
    'resources',
    'whenToUse',
    'executable',
    'version',
    'license',
    'notes',
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) warnings.push(`unknown conductor.json key ignored: ${key}`);
  }
  const sidecar = {
    triggers: normalizeStringList(raw.triggers),
    avoidTriggers: normalizeStringList(raw.avoidTriggers),
    tags: normalizeStringList(raw.tags),
    requiredCapabilities: normalizeStringList(raw.requiredCapabilities),
    dependencies: normalizeStringList(raw.dependencies),
    conflicts: normalizeStringList(raw.conflicts),
    resources: normalizeStringList(raw.resources).map((item) => validateRelativeReference(item, 'resources')),
    whenToUse: typeof raw.whenToUse === 'string' ? raw.whenToUse : '',
    version: typeof raw.version === 'string' ? raw.version : '',
    license: typeof raw.license === 'string' ? raw.license : '',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    executable: null,
    warnings,
    sidecarPath,
  };
  if (raw.executable !== undefined) {
    if (!raw.executable || typeof raw.executable !== 'object' || Array.isArray(raw.executable)) {
      throw new Error('executable must be an object with name and entry');
    }
    const name = raw.executable.name;
    const entry = raw.executable.entry;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('executable.name must be a non-empty string');
    }
    validateRelativeReference(entry, 'executable.entry');
    const runtime = raw.executable.runtime ?? 'node';
    if (runtime !== 'node') {
      throw new Error('only executable.runtime "node" is supported in v0.1');
    }
    sidecar.executable = { name: name.trim(), entry, runtime };
  }
  return sidecar;
}

async function readSkillAt(dir, root, relDir, issues) {
  const skillPath = path.join(dir, SKILL_FILE);
  let stat;
  try {
    stat = await fs.stat(skillPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_SKILL_BYTES) {
    issues.push(
      issue('error', 'skill_too_large', `SKILL.md exceeds ${MAX_SKILL_BYTES} bytes: ${skillPath}`, {
        path: skillPath,
      }),
    );
    return null;
  }
  const source = await fs.readFile(skillPath, 'utf8');
  const hash = sha256(source);
  const parsed = parseFrontmatter(source, { maxBytes: MAX_SKILL_BYTES });
  const validIssues = [];
  for (const parseError of parsed.errors) {
    validIssues.push(issue('error', 'malformed_frontmatter', parseError.message, { path: skillPath, line: parseError.line }));
  }
  for (const warning of parsed.warnings) {
    validIssues.push(issue('warning', 'frontmatter_warning', warning.message, { path: skillPath, line: warning.line }));
  }
  const data = parsed.data;
  let name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) {
    validIssues.push(issue('error', 'missing_name', 'SKILL.md frontmatter has no usable name', { path: skillPath }));
  }
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!description) {
    validIssues.push(issue('warning', 'missing_description', 'SKILL.md has no description', { path: skillPath }));
  }

  let sidecar = null;
  let sidecarSha = null;
  const sidecarPath = path.join(dir, SIDECAR_FILE);
  try {
    const sidecarStat = await fs.stat(sidecarPath);
    if (sidecarStat.isFile()) {
      if (sidecarStat.size > 512 * 1024) throw new Error('conductor.json exceeds 512 KiB');
      const sidecarRaw = await readJson(sidecarPath, { maxBytes: 512 * 1024 });
      sidecarSha = (await sha256File(sidecarPath)).sha256;
      sidecar = parseSidecar(sidecarRaw, { sidecarPath });
      for (const warning of sidecar.warnings) {
        validIssues.push(issue('warning', 'sidecar_warning', warning, { path: sidecarPath }));
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      validIssues.push(issue('error', 'malformed_sidecar', `invalid conductor.json: ${error.message}`, { path: sidecarPath }));
      sidecar = null;
    }
  }

  const frontTags = normalizeStringList(data.tags);
  const frontTriggers = normalizeStringList(data.triggers);
  const frontAvoid = [
    ...normalizeStringList(data.avoid),
    ...normalizeStringList(data.avoid_when),
  ];
  const tags = [...new Set([...frontTags, ...(sidecar?.tags ?? [])])];
  const triggers = [...new Set([...frontTriggers, ...(sidecar?.triggers ?? [])])];
  const avoidTriggers = [...new Set([...frontAvoid, ...(sidecar?.avoidTriggers ?? [])])];
  const relativePath = relDir === '.' ? '' : posix(relDir);
  const id = relativePath ? `${root.namespace}:${relativePath}` : root.namespace;
  let realDir;
  try {
    realDir = await fs.realpath(dir);
  } catch {
    realDir = path.resolve(dir);
  }
  let rootReal;
  try {
    rootReal = await fs.realpath(root.path);
  } catch {
    rootReal = path.resolve(root.path);
  }
  const insideRoot = isInside(rootReal, realDir);
  const warnings = [...parsed.warnings];
  if (realDir !== path.resolve(dir)) warnings.push('skill directory is reached through a symlink');
  if (!insideRoot) {
    warnings.push(
      'skill directory resolves outside its configured root; root trust is not inherited (trust by exact execution.trustedSkillIds if intended)',
    );
    validIssues.push(
      issue('warning', 'symlink_outside_root', 'external symlink target is not trusted by the root', {
        path: realDir,
        root: rootReal,
      }),
    );
  }
  let executable = sidecar?.executable ?? null;
  if (executable) {
    try {
      const scriptReal = await resolveWithin(realDir, executable.entry);
      const scriptStat = await fs.stat(scriptReal);
      if (!scriptStat.isFile()) throw new Error('entry is not a regular file');
      executable = {
        ...executable,
        sha256: (await sha256File(scriptReal)).sha256,
        bytes: scriptStat.size,
      };
    } catch (error) {
      executable = { ...executable, sha256: null, error: error.message };
      validIssues.push(
        issue('error', 'invalid_executable', `executable entry is not usable: ${error.message}`, {
          path: sidecarPath,
          entry: executable.entry,
        }),
      );
    }
  }
  const skill = {
    id,
    name: name || null,
    description,
    tags,
    triggers,
    avoidTriggers,
    requiredCapabilities: sidecar?.requiredCapabilities ?? [],
    dependencies: sidecar?.dependencies ?? [],
    conflicts: sidecar?.conflicts ?? [],
    resources: sidecar?.resources ?? [],
    executable,
    whenToUse: sidecar?.whenToUse ?? '',
    version: sidecar?.version || String(data.version ?? ''),
    license: sidecar?.license || String(data.license ?? ''),
    namespace: root.namespace,
    rootSource: root.source ?? null,
    relativePath: relativePath || '.',
    dir: path.resolve(dir),
    realDir,
    skillFile: path.resolve(skillPath),
    sidecarFile: sidecarSha ? sidecarPath : null,
    sidecarSha256: sidecarSha,
    sha256: hash,
    bytes: Buffer.byteLength(source, 'utf8'),
    bodyBytes: Buffer.byteLength(parsed.body, 'utf8'),
    valid: validIssues.every((item) => item.severity !== 'error'),
    issues: validIssues,
    ambiguousName: false,
    rootTrusted: root.trusted && insideRoot,
    untrustedReason: !insideRoot
      ? 'symlink target outside configured root'
      : !root.trusted
        ? 'root not trusted'
        : null,
    discoveredAt: new Date().toISOString(),
  };
  for (const item of validIssues) {
    if (item.severity === 'error') {
      issues.push({ ...item, id, skill: name || id });
    } else if (warnings.length || item) {
      issues.push({ ...item, id, skill: name || id });
    }
  }
  return skill;
}

async function scanRoot(root, issues) {
  const skills = [];
  const visited = new Set();
  let dirs = 0;
  const stack = [{ dir: root.path, rel: '.', depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    dirs += 1;
    if (dirs > MAX_DIRS) {
      issues.push(issue('error', 'scan_limit', `directory limit ${MAX_DIRS} reached under ${root.path}`, { root: root.path }));
      break;
    }
    if (current.depth > MAX_DEPTH) {
      issues.push(issue('warning', 'depth_limit', `depth limit reached at ${current.dir}`, { root: root.path }));
      continue;
    }
    let realDir;
    try {
      realDir = await fs.realpath(current.dir);
    } catch (error) {
      issues.push(issue('error', 'unreadable_directory', `cannot realpath ${current.dir}: ${error.message}`, { root: root.path }));
      continue;
    }
    if (visited.has(realDir)) continue;
    visited.add(realDir);
    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch (error) {
      issues.push(issue('error', 'unreadable_directory', `cannot read ${current.dir}: ${error.message}`, { root: root.path }));
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const hasSkill = entries.some((entry) => entry.name === SKILL_FILE && (entry.isFile() || entry.isSymbolicLink()));
    if (hasSkill) {
      try {
        const skill = await readSkillAt(path.join(current.dir), root, current.rel, issues);
        if (skill) {
          if (skills.length >= MAX_SKILLS) {
            issues.push(issue('error', 'scan_limit', `skill limit ${MAX_SKILLS} reached under ${root.path}`, { root: root.path }));
            break;
          }
          skills.push(skill);
        }
      } catch (error) {
        issues.push(issue('error', 'skill_read_error', `cannot read skill at ${current.dir}: ${error.message}`, { root: root.path }));
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === SKILL_FILE || entry.name === SIDECAR_FILE) continue;
      if (DEFAULT_SKIP.has(entry.name)) continue;
      if (entry.name.startsWith('.') && !root.includeHidden) continue;
      const childDir = path.join(current.dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const target = await fs.stat(childDir);
          if (!target.isDirectory()) continue;
          const targetReal = await fs.realpath(childDir);
          if (!isInside(root.path, targetReal)) {
            issues.push(issue('warning', 'symlink_outside_root', `following symlink outside root: ${childDir} -> ${targetReal}`, { root: root.path }));
          }
        } catch {
          continue;
        }
      }
      const rel = current.rel === '.' ? entry.name : `${current.rel}/${entry.name}`;
      stack.push({ dir: childDir, rel, depth: current.depth + 1 });
    }
  }
  return skills;
}

export async function discoverCatalog(config) {
  const issues = [];
  const all = [];
  for (const root of config.roots) {
    const skills = await scanRoot(root, issues);
    all.push(...skills);
  }
  const byId = new Map();
  const seenPaths = new Map();
  for (const skill of all) {
    if (byId.has(skill.id)) {
      issues.push(
        issue('error', 'duplicate_id', `duplicate skill id ${skill.id}; keep it out of routing`, {
          id: skill.id,
          paths: [byId.get(skill.id).skillFile, skill.skillFile],
        }),
      );
      continue;
    }
    const pathKey = skill.skillFile.toLowerCase();
    if (seenPaths.has(pathKey)) {
      issues.push(issue('warning', 'duplicate_scan', `same SKILL.md discovered twice: ${skill.skillFile}`, { id: skill.id }));
    }
    seenPaths.set(pathKey, skill.id);
    byId.set(skill.id, skill);
  }

  const nameCounts = new Map();
  for (const skill of byId.values()) {
    if (skill.name) nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
  }
  const duplicateNames = {};
  for (const [name, count] of nameCounts) {
    if (count > 1) {
      const ids = [...byId.values()].filter((skill) => skill.name === name).map((skill) => skill.id);
      duplicateNames[name] = ids;
      issues.push(
        issue('warning', 'ambiguous_name', `skill name "${name}" is duplicated; use exact IDs: ${ids.join(', ')}`, {
          name,
          ids,
        }),
      );
      for (const id of ids) byId.get(id).ambiguousName = true;
    }
  }

  const skills = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const catalogHash = sha256(
    stableStringify(
      skills.map((skill) => [skill.id, skill.name, skill.sha256, skill.sidecarSha256, skill.executable?.sha256 ?? null, skill.valid]),
    ),
  );
  return {
    skills,
    byId,
    issues,
    duplicateNames,
    catalogHash,
    roots: config.roots.map((root) => ({
      path: root.path,
      namespace: root.namespace,
      trusted: root.trusted,
      source: root.source ?? null,
    })),
    scannedAt: new Date().toISOString(),
    counts: {
      skills: skills.length,
      valid: skills.filter((skill) => skill.valid).length,
      invalid: skills.filter((skill) => !skill.valid).length,
      errors: issues.filter((item) => item.severity === 'error').length,
      warnings: issues.filter((item) => item.severity === 'warning').length,
    },
  };
}

export function resolveSkill(catalog, identifier) {
  if (typeof identifier !== 'string' || identifier.trim() === '') {
    throw new CatalogError('skill identifier must be a non-empty string');
  }
  const exact = catalog.byId.get(identifier);
  if (exact) return exact;
  const matches = catalog.skills.filter((skill) => skill.name === identifier);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new CatalogError(`skill name "${identifier}" is ambiguous; use an exact ID`, {
      code: 'ambiguous_name',
      matches: matches.map((skill) => skill.id),
    });
  }
  throw new CatalogError(`skill not found: ${identifier}`, { identifier });
}

export async function loadSkillContent(skill, { maxBytes = MAX_SKILL_BYTES } = {}) {
  const stat = await fs.stat(skill.skillFile);
  if (stat.size > maxBytes) throw new CatalogError(`SKILL.md too large: ${skill.skillFile}`, { id: skill.id });
  const text = await fs.readFile(skill.skillFile, 'utf8');
  const hash = sha256(text);
  if (hash !== skill.sha256) {
    throw new CatalogError(`skill content changed since discovery: ${skill.id}`, {
      code: 'stale_skill',
      id: skill.id,
      expectedSha256: skill.sha256,
      actualSha256: hash,
    });
  }
  const parsed = parseFrontmatter(text, { maxBytes });
  if (!parsed.ok) {
    throw new CatalogError(`frontmatter parse failed on activation for ${skill.id}`, {
      id: skill.id,
      errors: parsed.errors,
    });
  }
  if (skill.sidecarFile) {
    const current = await sha256File(skill.sidecarFile);
    if (current.sha256 !== skill.sidecarSha256) {
      throw new CatalogError(`conductor.json changed since discovery: ${skill.id}`, {
        code: 'stale_skill',
        id: skill.id,
        expectedSha256: skill.sidecarSha256,
        actualSha256: current.sha256,
      });
    }
  }
  return {
    body: parsed.body,
    bodyBytes: Buffer.byteLength(parsed.body, 'utf8'),
    sha256: hash,
    baseDir: skill.realDir,
    frontmatter: parsed.data,
  };
}

export function catalogStatus(catalog) {
  if (catalog.counts.skills === 0) return 'no_user_skills';
  if (catalog.counts.valid === 0) return 'no_valid_user_skills';
  return 'ready';
}

export function catalogSummary(catalog, { includeIssues = true } = {}) {
  const status = catalogStatus(catalog);
  return {
    catalogHash: catalog.catalogHash,
    scannedAt: catalog.scannedAt,
    counts: catalog.counts,
    status,
    readyForRealTasks: status === 'ready',
    duplicateNames: catalog.duplicateNames,
    roots: catalog.roots,
    ...(status === 'no_user_skills'
      ? {
          nextAction:
            'No existing user skills were found. Add a SKILL.md under a host skill root or rerun setup --root PATH; no demo was installed.',
        }
      : {}),
    skills: catalog.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      triggers: skill.triggers,
      avoidTriggers: skill.avoidTriggers,
      requiredCapabilities: skill.requiredCapabilities,
      dependencies: skill.dependencies,
      conflicts: skill.conflicts,
      resources: skill.resources,
      executable: skill.executable
        ? {
            name: skill.executable.name,
            entry: skill.executable.entry,
            runtime: skill.executable.runtime,
            sha256: skill.executable.sha256 ?? null,
            ...(skill.executable.error ? { error: skill.executable.error } : {}),
          }
        : null,
      version: skill.version,
      license: skill.license,
      sha256: skill.sha256,
      sidecarSha256: skill.sidecarSha256,
      relativePath: skill.relativePath,
      rootSource: skill.rootSource ?? null,
      rootTrusted: skill.rootTrusted,
      untrustedReason: skill.untrustedReason,
      valid: skill.valid,
      ambiguousName: skill.ambiguousName,
      issues: skill.issues,
    })),
    ...(includeIssues ? { issues: catalog.issues } : {}),
  };
}

export { decodeUtf8, MAX_SKILL_BYTES };
