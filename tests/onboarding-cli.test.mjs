import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir, projectRoot } from './helpers.mjs';

const bin = path.join(projectRoot, 'bin', 'skill-conductor.mjs');

function runCli(args, { cwd }) {
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

async function listWithoutConfig(cwd) {
  const result = await runCli(['list'], { cwd });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function writeSkillAt(root, name) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "Fixture skill ${name} for local discovery."\n---\n\n# ${name}\n`,
    'utf8',
  );
}

test('init --demo is safe in a spaced Chinese path, refuses overwrite, and demo writes under the caller', async (t) => {
  const dir = await makeTempDir(t, 'onboarding 中文 path');
  const first = await runCli(['init', '--demo'], { cwd: dir });
  assert.equal(first.code, 0, first.stderr);
  const initialized = JSON.parse(first.stdout);
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.demo, true);

  const configPath = path.join(dir, '.skill-conductor', 'config.json');
  const configBody = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(configBody);
  assert.equal(config.policy.mode, 'ask');
  assert.equal(config.assistance.enabled, true);
  assert.equal(config.assistance.profile, 'balanced');
  assert.equal(config.execution.enabled, true);
  assert.deepEqual(config.execution.trustedSkillIds, ['demo:csv-inspector', 'demo:markdown-report']);
  assert.ok(config.execution.allowlist.every((id) => config.execution.trustedSkillIds.includes(id)));
  assert.equal(await fs.stat(path.join(dir, '.skill-conductor', 'demo', 'data', '销售 数据.csv')).then(() => true), true);

  const second = await runCli(['init', '--demo'], { cwd: dir });
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /refusing to overwrite/i);
  assert.equal(await fs.readFile(configPath, 'utf8'), configBody, 'failed init must not modify the config');

  const nested = path.join(dir, 'nested 目录', 'deeper');
  await fs.mkdir(nested, { recursive: true });
  const listed = await listWithoutConfig(nested);
  assert.equal(listed.counts.skills, 4);
  assert.ok(listed.roots[0].path.startsWith(dir));

  const demo = await runCli(['demo'], { cwd: nested });
  assert.equal(demo.code, 0, demo.stderr);
  const result = JSON.parse(demo.stdout);
  assert.equal(result.status, 'verified');
  assert.ok(result.artifactDir.startsWith(dir), `artifact dir escaped caller: ${result.artifactDir}`);
  assert.ok(!result.artifactDir.startsWith(path.join(projectRoot, 'runs')));
  assert.equal(await fs.stat(path.join(result.artifactDir, 'report.md')).then(() => true), true);
});

test('init --root and explicit --config precedence work with non-ASCII roots', async (t) => {
  const dir = await makeTempDir(t, 'root 测试');
  const localRoot = path.join(dir, '现有 技能');
  await writeSkillAt(localRoot, 'alpha');

  const initialized = await runCli(['init', '--root', '现有 技能'], { cwd: dir });
  assert.equal(initialized.code, 0, initialized.stderr);
  const listed = await listWithoutConfig(dir);
  assert.equal(listed.counts.skills, 1);
  assert.equal(listed.skills[0].id, 'local:alpha');
  assert.equal(listed.roots[0].namespace, 'local');

  const otherRoot = path.join(dir, 'other 技能');
  await writeSkillAt(otherRoot, 'beta');
  const explicit = {
    roots: [{ path: './other 技能', namespace: 'other', trusted: false }],
    selector: { mode: 'lexical', minScore: 0.01 },
    policy: { mode: 'ask' },
    execution: { enabled: false, runDir: './other-runs' },
    materials: { allowRoots: ['.'] },
  };
  await fs.writeFile(path.join(dir, 'explicit.json'), `${JSON.stringify(explicit, null, 2)}\n`, 'utf8');
  const explicitResult = await runCli(['list', '--config', 'explicit.json'], { cwd: dir });
  assert.equal(explicitResult.code, 0, explicitResult.stderr);
  const explicitList = JSON.parse(explicitResult.stdout);
  assert.deepEqual(explicitList.skills.map((skill) => skill.id), ['other:beta']);
  assert.equal(explicitList.roots[0].namespace, 'other');
});

test('default demo needs no init and writes outside the installed package', async (t) => {
  const dir = await makeTempDir(t, 'demo no init 中文');
  const demo = await runCli(['demo'], { cwd: dir });
  assert.equal(demo.code, 0, demo.stderr);
  const result = JSON.parse(demo.stdout);
  assert.equal(result.status, 'verified');
  assert.equal(result.verification.verified, true);
  assert.ok(result.artifactDir.startsWith(dir), `artifact dir escaped caller: ${result.artifactDir}`);
  assert.ok(!result.artifactDir.startsWith(path.join(projectRoot, 'runs')), `artifact dir is inside the installed runs tree: ${result.artifactDir}`);
  assert.ok(!result.artifactDir.startsWith(path.join(projectRoot, 'skills')), `artifact dir is inside the installed skills tree: ${result.artifactDir}`);
  assert.equal(await fs.stat(path.join(result.artifactDir, 'report.md')).then(() => true), true);
});

test('a missing config produces an actionable error instead of reading global state', async (t) => {
  const dir = await makeTempDir(t, 'no config 中文');
  const result = await runCli(['route', '请计算'], { cwd: dir });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no skill-conductor config found/i);
  assert.match(result.stderr, /init --demo|--config PATH/i);
});
