import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnWithTreeKill, killProcessTree } from '../src/util.mjs';
import { makeTempDir } from './helpers.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true;
  }
}

test('killProcessTree terminates a real child and its grandchild', async (t) => {
  const dir = await makeTempDir(t, 'tree-kill');
  const pidFile = path.join(dir, 'grandchild.pid');
  const parentScript = path.join(dir, 'parent.mjs');
  await fs.writeFile(
    parentScript,
    [
      "import { spawn } from 'node:child_process';",
      "import fs from 'node:fs';",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'fs.writeFileSync(process.argv[2], String(child.pid));',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
    'utf8',
  );

  const parent = spawnWithTreeKill(process.execPath, [parentScript, pidFile], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    try {
      killProcessTree(parent);
    } catch {
      // already gone
    }
  });

  const ready = await waitFor(async () => {
    try {
      return (await fs.readFile(pidFile, 'utf8')).trim() !== '';
    } catch {
      return false;
    }
  });
  assert.equal(ready, true, 'parent did not report its grandchild pid');
  const grandchildPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
  assert.equal(alive(grandchildPid), true);

  killProcessTree(parent);
  await new Promise((resolve) => {
    if (parent.exitCode !== null) return resolve();
    parent.once('close', resolve);
  });

  const gone = await waitFor(() => !alive(grandchildPid));
  assert.equal(gone, true, 'grandchild survived process-tree cleanup');
});
