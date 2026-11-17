import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const posix = (value) => String(value).replaceAll(path.sep, '/');

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(file) {
  const data = await fs.readFile(file);
  return { sha256: sha256(data), bytes: data.byteLength };
}

/** Clamp helper used for confidence/score normalisation. */
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix = 'run') {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

export async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** True when child equals parent or is below it. Inputs should already be realpaths. */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Resolve a relative reference beneath a directory, rejecting absolute paths,
 * drive-qualified paths, ".." components and symlink escapes.
 */
export async function resolveWithin(baseDir, reference, { mustExist = true } = {}) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    throw new Error('path reference must be a non-empty string');
  }
  if (path.isAbsolute(reference) || /^[A-Za-z]:/.test(reference) || reference.startsWith('\\\\')) {
    throw new Error(`refusing absolute path: ${reference}`);
  }
  const normal = reference.replaceAll('\\', '/');
  if (normal.split('/').some((part) => part === '..')) {
    throw new Error(`refusing path traversal: ${reference}`);
  }
  const baseReal = await fs.realpath(baseDir);
  const logical = path.resolve(baseReal, reference);
  if (!isInside(baseReal, logical)) throw new Error(`path escapes skill directory: ${reference}`);
  let real = logical;
  if (mustExist) {
    try {
      real = await fs.realpath(logical);
    } catch (error) {
      throw new Error(`path does not exist: ${reference} (${error.code || 'read_error'})`);
    }
    if (!isInside(baseReal, real)) throw new Error(`symlink escapes skill directory: ${reference}`);
  }
  return real;
}

/** Read at most maxBytes from the head of a file without reading the whole file. */
export async function readFilePrefix(file, maxBytes) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    const toRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(toRead);
    let offset = 0;
    while (offset < toRead) {
      const { bytesRead } = await handle.read(buffer, offset, toRead - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      buffer: buffer.subarray(0, offset),
      bytes: stat.size,
      readBytes: offset,
      truncated: stat.size > maxBytes,
    };
  } finally {
    await handle.close();
  }
}

/** Decode UTF-8 without throwing on a truncated multi-byte sequence. */
export function decodeUtf8(buffer) {
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

export function truncateText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

export function asStringArray(value, field) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${field}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Redact obvious credentials and optionally known secret values. */
export function redactSecrets(text, secrets = []) {
  let result = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  result = result
    .replace(/\bsk-[A-Za-z0-9_\-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._\-]{12,}\b/gi, '$1[REDACTED]')
    .replace(/\b(api[_-]?key|token|authorization)\s*[:=]\s*["']?[^\s"']{12,}/gi, '$1=[REDACTED]');
  return result;
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJson(file, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`not a regular file: ${file}`);
  if (stat.size > maxBytes) throw new Error(`JSON file too large (${stat.size} > ${maxBytes}): ${file}`);
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

export function relativeDisplay(baseDir, target) {
  const rel = path.relative(baseDir, target);
  return posix(rel || '.');
}

const PROCESS_GROUP = Symbol.for('skill-conductor.process-group');

/**
 * Spawn a child in its own POSIX process group so timeout cleanup can signal
 * the whole group, not only the direct child. Windows uses taskkill /T instead.
 * stdin/stdout/stderr pipes still work with a detached process group.
 */
export function spawnWithTreeKill(command, args, options = {}) {
  const detached = process.platform !== 'win32';
  const child = spawn(command, args, { ...options, detached });
  if (detached) child[PROCESS_GROUP] = true;
  return child;
}

/**
 * Terminate a child process tree without shell:true. Used for timeouts and
 * output-limit enforcement; callers still await the child's close event.
 * POSIX group kill only applies to children from spawnWithTreeKill, so a
 * caller-supplied ordinary child is never able to signal our own group.
 */
export function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      });
      return;
    } catch {
      // fall through
    }
  }
  if (process.platform !== 'win32' && child.pid && child[PROCESS_GROUP]) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // group may already be gone; try the direct child below
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

