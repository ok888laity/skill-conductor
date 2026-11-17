import fs from 'node:fs/promises';
import path from 'node:path';
import { DecisionError } from './errors.mjs';
import { nowIso, readJson, resolveWithin, sha256, sha256File, stableStringify } from './util.mjs';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 8000;
const STALE_LOCK_MS = 60000;

export function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new DecisionError('invalid_run_id', `invalid run id: ${String(runId)}`);
  }
  return runId;
}

/** Stable integrity token over the pending plan. Not a secret; it prevents stale UI choices. */
export function computePlanHash(record) {
  return sha256(
    stableStringify({
      schema: 'skill-conductor/plan/v0.1',
      runId: record.runId,
      mode: record.mode,
      catalogHash: record.catalogHash,
      configFingerprint: record.configFingerprint,
      candidates: (record.candidates ?? []).map((candidate) => [
        candidate.id,
        candidate.sha256,
        candidate.sidecarSha256 ?? null,
        candidate.executable?.sha256 ?? null,
      ]),
      recommendation: (record.recommendation?.selected ?? []).map((entry) => entry.id),
      abstainReason: record.recommendation?.abstainReason ?? null,
    }),
  );
}

/**
 * Persistent run/decision store. Writes are temp-file + rename, decisions are
 * validated under a cross-process lock, and resume execution is claimed once.
 */
export class RunStore {
  constructor({ runDir }) {
    if (typeof runDir !== 'string' || runDir.trim() === '') {
      throw new DecisionError('invalid_run_dir', 'runDir must be a non-empty string');
    }
    this.runDir = path.resolve(runDir);
    this.lockPath = path.join(this.runDir, '.store.lock');
  }

  async ensure() {
    await fs.mkdir(this.runDir, { recursive: true });
  }

  recordPath(runId) {
    return path.join(this.runDir, `${assertRunId(runId)}.json`);
  }

  eventsPath(runId) {
    return path.join(this.runDir, `${assertRunId(runId)}.events.jsonl`);
  }

  artifactDir(runId) {
    return path.join(this.runDir, 'artifacts', assertRunId(runId));
  }

  async _acquireLock() {
    await this.ensure();
    const started = Date.now();
    for (;;) {
      try {
        const handle = await fs.open(this.lockPath, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowIso() }));
        await handle.close();
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let stat = null;
        try {
          stat = await fs.stat(this.lockPath);
        } catch {
          continue;
        }
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          try {
            await fs.unlink(this.lockPath);
          } catch {
            // another process removed it
          }
          continue;
        }
        if (Date.now() - started > LOCK_TIMEOUT_MS) {
          throw new DecisionError('store_locked', 'run store lock timeout; another process is updating it');
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }

  async _releaseLock() {
    try {
      await fs.unlink(this.lockPath);
    } catch {
      // lock was already stale-removed
    }
  }

  async _withLock(fn) {
    await this._acquireLock();
    try {
      return await fn();
    } finally {
      await this._releaseLock();
    }
  }

  async _writeAtomic(file, record) {
    const temp = `${file}.tmp-${process.pid}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    try {
      await fs.rename(temp, file);
    } catch (error) {
      // Windows may refuse to replace an existing file; retry once after unlink.
      if (error.code === 'EEXIST' || error.code === 'EPERM') {
        await fs.unlink(file).catch(() => {});
        await fs.rename(temp, file);
      } else {
        await fs.unlink(temp).catch(() => {});
        throw error;
      }
    }
  }

  async create(record) {
    assertRunId(record.runId);
    return this._withLock(async () => {
      const file = this.recordPath(record.runId);
      try {
        await fs.access(file);
        throw new DecisionError('duplicate_run', `run already exists: ${record.runId}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await this._writeAtomic(file, record);
      await this.appendEvent(record.runId, { type: 'run_created', status: record.status, mode: record.mode });
      return record;
    });
  }

  async get(runId) {
    const file = this.recordPath(runId);
    try {
      const record = await readJson(file, { maxBytes: 8 * 1024 * 1024 });
      if (!record || record.runId !== runId) {
        throw new DecisionError('corrupt_run', `run record does not match ${runId}`);
      }
      return record;
    } catch (error) {
      if (error instanceof DecisionError) throw error;
      if (error.code === 'ENOENT') throw new DecisionError('unknown_run', `run not found: ${runId}`);
      throw new DecisionError('corrupt_run', `cannot read run ${runId}: ${error.message}`);
    }
  }

  async update(runId, mutator) {
    assertRunId(runId);
    return this._withLock(async () => {
      const record = await this.get(runId);
      const next = (await mutator(record)) ?? record;
      next.updatedAt = nowIso();
      await this._writeAtomic(this.recordPath(runId), next);
      return next;
    });
  }

  async appendEvent(runId, event) {
    await this.ensure();
    const line = JSON.stringify({ at: nowIso(), runId, ...event });
    await fs.appendFile(this.eventsPath(runId), `${line}\n`, 'utf8');
  }

  async list() {
    await this.ensure();
    const entries = await fs.readdir(this.runDir, { withFileTypes: true });
    const runs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const runId = entry.name.slice(0, -5);
      if (!RUN_ID_PATTERN.test(runId)) continue;
      try {
        const record = await this.get(runId);
        runs.push({
          runId: record.runId,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          mode: record.mode,
          status: record.status,
          task: record.task,
          recommendation: (record.recommendation?.selected ?? []).map((entry) => entry.id),
          decision: record.decision ? { chosenIds: record.decision.chosenIds, skip: record.decision.skip } : null,
          states: record.states,
        });
      } catch {
        // ignore a partially written or corrupt record in listings
      }
    }
    return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async decide(runId, { skills, skip = false, decidedBy = 'owner', decisionToken = null, configFingerprint = null }) {
    return this.update(runId, async (record) => {
      if (record.decision) {
        throw new DecisionError('already_decided', `run ${runId} already has a decision`);
      }
      if (record.status !== 'awaiting_choice') {
        throw new DecisionError('not_pending', `run ${runId} is not awaiting a choice (status: ${record.status})`);
      }
      if (decisionToken && decisionToken !== record.planHash) {
        throw new DecisionError('stale_plan', 'decision token does not match the pending plan');
      }
      if (configFingerprint && record.configFingerprint && configFingerprint !== record.configFingerprint) {
        throw new DecisionError('stale_config', 'config roots/capabilities changed since this run was prepared');
      }
      const candidateIds = (record.candidates ?? []).map((candidate) => candidate.id);
      let chosenIds = [];
      if (!skip) {
        if (!Array.isArray(skills) || skills.length === 0) {
          throw new DecisionError('missing_choice', 'provide --skills ID,ID or --skip');
        }
        chosenIds = [...new Set(skills.map((skill) => String(skill).trim()))];
        if (chosenIds.some((id) => id === '')) {
          throw new DecisionError('invalid_choice', 'chosen skill id must not be empty');
        }
        const unknown = chosenIds.filter((id) => !candidateIds.includes(id));
        if (unknown.length > 0) {
          throw new DecisionError('unknown_choice', `choices are not pending candidates: ${unknown.join(', ')}`, {
            allowed: candidateIds,
          });
        }
      }
      const chosen = (record.candidates ?? []).filter((candidate) => chosenIds.includes(candidate.id));
      const hashes = [];
      for (const candidate of chosen) {
        let actual;
        try {
          actual = await sha256File(candidate.skillFile);
        } catch (error) {
          throw new DecisionError('stale_skill', `cannot re-read ${candidate.id}: ${error.message}`, { id: candidate.id });
        }
        if (actual.sha256 !== candidate.sha256) {
          throw new DecisionError('stale_skill', `SKILL.md changed after prepare: ${candidate.id}`, {
            id: candidate.id,
            expectedSha256: candidate.sha256,
            actualSha256: actual.sha256,
          });
        }
        if (candidate.sidecarSha256) {
          let sidecar;
          try {
            sidecar = await sha256File(candidate.sidecarFile);
          } catch (error) {
            throw new DecisionError('stale_skill', `conductor.json missing or unreadable: ${candidate.id}`, {
              id: candidate.id,
            });
          }
          if (sidecar.sha256 !== candidate.sidecarSha256) {
            throw new DecisionError('stale_skill', `conductor.json changed after prepare: ${candidate.id}`, {
              id: candidate.id,
              expectedSha256: candidate.sidecarSha256,
              actualSha256: sidecar.sha256,
            });
          }
        }
        let executableSha256 = null;
        if (candidate.executable?.entry) {
          if (!candidate.executable.sha256) {
            throw new DecisionError('stale_skill', `executable was unusable when prepared: ${candidate.id}`, {
              id: candidate.id,
            });
          }
          let script;
          try {
            script = await resolveWithin(candidate.realDir, candidate.executable.entry);
            executableSha256 = (await sha256File(script)).sha256;
          } catch (error) {
            throw new DecisionError('stale_skill', `executable missing or unreadable: ${candidate.id}`, {
              id: candidate.id,
            });
          }
          if (executableSha256 !== candidate.executable.sha256) {
            throw new DecisionError('stale_skill', `executable script changed after prepare: ${candidate.id}`, {
              id: candidate.id,
              expectedSha256: candidate.executable.sha256,
              actualSha256: executableSha256,
            });
          }
        }
        hashes.push({
          id: candidate.id,
          sha256: actual.sha256,
          sidecarSha256: candidate.sidecarSha256 ?? null,
          executableSha256,
        });
      }
      const decisionHash = sha256(
        stableStringify({
          schema: 'skill-conductor/decision/v0.1',
          planHash: record.planHash,
          chosenIds: [...chosenIds].sort(),
          skip,
          decidedBy,
        }),
      );
      record.decision = {
        chosenIds,
        skip,
        decidedBy,
        decidedAt: nowIso(),
        decisionHash,
        planHash: record.planHash,
        hashes,
        ...(skip ? { reason: 'owner skipped this run' } : {}),
      };
      record.status = 'decided';
      record.states = { ...record.states, decided: true };
      return record;
    });
  }

  /** Atomically claim a decided run so two callers cannot execute it twice. */
  async claimResume(runId, { claimedBy = 'owner' } = {}) {
    return this.update(runId, (record) => {
      if (!record.decision) throw new DecisionError('no_decision', `run ${runId} has no decision`);
      if (record.resumeClaim) {
        throw new DecisionError('already_claimed', `run ${runId} is already being resumed`);
      }
      if (record.status !== 'decided') {
        throw new DecisionError('not_resumable', `run ${runId} is not resumable (status: ${record.status})`);
      }
      record.resumeClaim = { claimedBy, claimedAt: nowIso(), claimId: globalThis.crypto.randomUUID() };
      return record;
    });
  }
}

export function createRunStore(config) {
  return new RunStore({ runDir: config.execution.runDir });
}
