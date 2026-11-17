import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseCordisCommand } from '../src/host-integration.mjs';
import { makeTempDir, projectRoot } from './helpers.mjs';

const bin = path.join(projectRoot, 'bin', 'skill-conductor.mjs');

function runCli(args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      env,
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

async function workspace(t, label) {
  const dir = await makeTempDir(t, label);
  const fakeHome = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  await fs.mkdir(fakeHome, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  return { dir, fakeHome, project };
}

async function writeSkillAt(root, name, description = `${name} actual user skill`) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\nUser-owned instruction body.\n`,
    'utf8',
  );
  return dir;
}

async function setup(project, fakeHome, extra = []) {
  const result = await runCli(['setup', '--home', fakeHome, ...extra], { cwd: project });
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

async function readConfig(project) {
  return JSON.parse(await fs.readFile(path.join(project, '.skill-conductor', 'config.json'), 'utf8'));
}

function mcpSession({ command, args, cwd }) {
  const child = spawn(command, args, {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let stderr = '';
  const nonJson = [];
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  rl.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      nonJson.push(line);
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const closed = new Promise((resolve) => child.on('close', resolve));
  return {
    get stderr() {
      return stderr;
    },
    get nonJson() {
      return nonJson;
    },
    request(method, params) {
      const id = nextId;
      nextId += 1;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP timeout ${method}: ${stderr}`)), 15000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async close() {
      child.stdin.end();
      await closed;
    },
  };
}

async function handshake(command, args, cwd) {
  const session = mcpSession({ command, args, cwd });
  try {
    const init = await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'generated-host-fixture', version: '1' },
    });
    session.notify('notifications/initialized', {});
    const tools = await session.request('tools/list', {});
    assert.equal(init.result.serverInfo.name, 'skill-conductor');
    assert.deepEqual(session.nonJson, [], 'MCP stdout must be protocol-only');
    return {
      serverInfo: init.result.serverInfo,
      tools: tools.result.tools.map((tool) => tool.name),
    };
  } finally {
    await session.close();
  }
}

test('setup discovers real project/user/shared/plugin roots without demo, trust or execution', async (t) => {
  const { dir, fakeHome, project } = await workspace(t, 'setup discovery 中文 path');
  await writeSkillAt(path.join(project, '.cursor', 'skills'), 'cursor-project');
  await writeSkillAt(path.join(project, '.claude', 'skills'), 'claude-project');
  await writeSkillAt(path.join(project, '.agents', 'skills'), 'agents-project');
  await writeSkillAt(path.join(project, '.opencode', 'skills'), 'opencode-project');
  await writeSkillAt(path.join(project, '.qoder', 'skills'), 'qoder-project');
  await writeSkillAt(path.join(project, '.workbuddy', 'skills'), 'workbuddy-project');
  await writeSkillAt(path.join(project, '.dsh', 'skills'), 'dsh-project');
  await writeSkillAt(path.join(project, 'skills'), 'generic-project');
  await writeSkillAt(path.join(fakeHome, '.cursor', 'skills'), 'cursor-user');
  await writeSkillAt(path.join(fakeHome, '.claude', 'skills'), 'claude-user');
  await writeSkillAt(path.join(fakeHome, '.codex', 'skills'), 'codex-user');
  await writeSkillAt(path.join(fakeHome, '.codex', 'skills', '.system'), 'system-skill');
  await writeSkillAt(
    path.join(fakeHome, '.codex', 'plugins', 'cache', 'vendor', 'plugin', '1.0', 'skills'),
    'plugin-skill',
  );
  await writeSkillAt(path.join(project, '.skill-conductor', 'demo', 'skills'), 'internal-demo');

  const result = await setup(project, fakeHome, [
    '--host',
    'cursor',
    '--root',
    '.cursor/skills',
    '--root',
    '.cursor/skills',
    '--no-host-config',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.status, 'ready');
  assert.equal(result.json.setupStatus, 'created');
  assert.ok(result.json.roots.length >= 12, JSON.stringify(result.json.roots));
  assert.equal(result.json.roots[0].namespace, 'cursor-project');
  const agentsRoot = result.json.roots.find((root) => root.namespace === 'agents-project');
  assert.ok(agentsRoot, 'explicit project .agents/skills root must be discovered');
  assert.equal(path.relative(project, agentsRoot.path), path.join('.agents', 'skills'));
  assert.equal(result.json.demo.includedInUserCatalog, false);
  assert.equal(result.json.demo.routed, false);

  const config = await readConfig(project);
  assert.equal(config.policy.mode, 'ask');
  assert.equal(config.assistance.enabled, true);
  assert.equal(config.execution.enabled, false);
  assert.deepEqual(config.execution.trustedSkillIds, []);
  assert.ok(config.roots.every((root) => root.trusted === false));
  assert.ok(config.roots.every((root) => root.source?.kind === 'discovered'));
  assert.equal(new Set(config.roots.map((root) => root.namespace)).size, config.roots.length);
  assert.ok(config.roots.some((root) => root.source?.host === 'codex' && root.source?.scope === 'user'));
  assert.ok(config.roots.some((root) => root.source?.host === 'codex' && root.includeHidden === true));
  assert.ok(config.roots.some((root) => root.source?.host === 'generic'));

  const listed = await runCli(['list', '--home', fakeHome], { cwd: project });
  assert.equal(listed.code, 0, listed.stderr);
  const catalog = JSON.parse(listed.stdout);
  assert.equal(catalog.status, 'ready');
  assert.ok(catalog.counts.skills >= 13);
  assert.ok(!catalog.skills.some((skill) => skill.id.includes('internal-demo')));
  assert.ok(!catalog.skills.some((skill) => skill.id.startsWith('demo:')));
  assert.ok(catalog.skills.some((skill) => skill.rootSource?.host === 'codex'));

  const configBefore = await fs.readFile(path.join(project, '.skill-conductor', 'config.json'), 'utf8');
  const again = await setup(project, fakeHome, ['--host', 'cursor', '--no-host-config']);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.setupStatus, 'already_configured');
  assert.equal(again.json.changed, false);
  const configAfter = await fs.readFile(path.join(project, '.skill-conductor', 'config.json'), 'utf8');
  assert.equal(configAfter, configBefore);
  const backups = await fs.stat(path.join(project, '.skill-conductor', 'backups')).then(() => true).catch(() => false);
  assert.equal(backups, false);
});

test('empty discovery is an honest deliberate empty catalog, never a demo fallback', async (t) => {
  const { fakeHome, project } = await workspace(t, 'setup-empty');
  const initialized = await setup(project, fakeHome);
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.equal(initialized.json.status, 'no_user_skills');
  assert.equal(initialized.json.readyForRealTasks, false);
  assert.deepEqual(initialized.json.roots, []);
  const config = await readConfig(project);
  assert.deepEqual(config.roots, []);
  assert.equal(config.setup.managedBy, 'skill-conductor');

  const listed = await runCli(['list', '--home', fakeHome], { cwd: project });
  assert.equal(listed.code, 0, listed.stderr);
  const catalog = JSON.parse(listed.stdout);
  assert.equal(catalog.status, 'no_user_skills');
  assert.equal(catalog.counts.skills, 0);
  assert.match(catalog.nextAction, /no demo/i);

  const routed = await runCli(['route', '做一个销售报告', '--home', fakeHome], { cwd: project });
  assert.equal(routed.code, 0, routed.stderr);
  const run = JSON.parse(routed.stdout);
  assert.equal(run.status, 'no_match');
  assert.match(run.recommendation.abstainReason, /no_user_skills/i);
  assert.equal(run.states.executed, false);
  assert.equal(run.states.activated, false);
  const demoExists = await fs.stat(path.join(project, '.skill-conductor', 'demo')).then(() => true).catch(() => false);
  assert.equal(demoExists, false);
});

test('recognized demo-only scaffold is backed up, migrated, and demo trust is removed', async (t) => {
  const { fakeHome, project } = await workspace(t, 'setup-migrate');
  const init = await runCli(['init', '--demo'], { cwd: project });
  assert.equal(init.code, 0, init.stderr);
  await writeSkillAt(path.join(project, '.claude', 'skills'), 'real-sales-report');
  const configPath = path.join(project, '.skill-conductor', 'config.json');
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  raw.policy.mode = 'auto';
  raw.assistance.enabled = false;
  raw.assistance.profile = 'conservative';
  await fs.writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const before = await fs.readFile(configPath, 'utf8');

  const migrated = await setup(project, fakeHome);
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.equal(migrated.json.setupStatus, 'migrated_demo_scaffold');
  assert.equal(migrated.json.status, 'ready');
  assert.equal(migrated.json.migration.demoFilesPreserved, true);
  assert.equal(migrated.json.migration.demoTrustRemoved, true);
  assert.ok(migrated.json.backupPath);

  const backup = await fs.readFile(migrated.json.backupPath, 'utf8');
  assert.equal(backup, before);
  const config = await readConfig(project);
  assert.equal(config.policy.mode, 'auto');
  assert.equal(config.assistance.enabled, false);
  assert.equal(config.assistance.profile, 'conservative');
  assert.equal(config.execution.enabled, false);
  assert.deepEqual(config.execution.trustedSkillIds, []);
  assert.deepEqual(config.execution.allowlist, []);
  assert.ok(config.roots.some((root) => root.source?.host === 'claude'));
  assert.ok(!config.roots.some((root) => root.namespace === 'demo'));
  const demoFile = path.join(project, '.skill-conductor', 'demo', 'skills', 'csv-inspector', 'SKILL.md');
  assert.equal(await fs.stat(demoFile).then(() => true), true);

  const listed = await runCli(['list'], { cwd: project });
  assert.equal(listed.code, 0, listed.stderr);
  const catalog = JSON.parse(listed.stdout);
  assert.deepEqual(catalog.skills.map((skill) => skill.name), ['real-sales-report']);

  const backupDir = path.join(project, '.skill-conductor', 'backups');
  const backupCount = (await fs.readdir(backupDir)).length;
  const again = await setup(project, fakeHome);
  assert.equal(again.json.setupStatus, 'already_configured');
  assert.equal((await fs.readdir(backupDir)).length, backupCount);
});

test('custom configs are preserved; invalid custom configs are reported without overwrite', async (t) => {
  const { fakeHome, project } = await workspace(t, 'setup-custom');
  await writeSkillAt(path.join(project, 'xskills'), 'custom-one');
  const configDir = path.join(project, '.skill-conductor');
  await fs.mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.json');
  const custom = {
    roots: [{ path: '../xskills', namespace: 'mine', trusted: false }],
    selector: { mode: 'lexical' },
    policy: { mode: 'ask' },
    execution: { enabled: false, runDir: './runs' },
    materials: { allowRoots: ['..'] },
  };
  await fs.writeFile(configPath, `${JSON.stringify(custom, null, 2)}\n`, 'utf8');
  const before = await fs.readFile(configPath, 'utf8');
  const preserved = await setup(project, fakeHome);
  assert.equal(preserved.code, 0, preserved.stderr);
  assert.equal(preserved.json.setupStatus, 'existing_custom_config_preserved');
  assert.equal(preserved.json.changed, false);
  assert.equal(preserved.json.catalog.counts.skills, 1);
  assert.equal(await fs.readFile(configPath, 'utf8'), before);

  const brokenDir = path.join(project, 'broken');
  await fs.mkdir(brokenDir, { recursive: true });
  const brokenPath = path.join(brokenDir, 'config.json');
  await fs.writeFile(
    brokenPath,
    `${JSON.stringify({ roots: [{ path: './missing', namespace: 'broken' }] }, null, 2)}\n`,
    'utf8',
  );
  const brokenBefore = await fs.readFile(brokenPath, 'utf8');
  const broken = await runCli(['setup', '--home', fakeHome, '--config', brokenPath], { cwd: project });
  assert.notEqual(broken.code, 0);
  const brokenJson = JSON.parse(broken.stdout);
  assert.equal(brokenJson.setupStatus, 'existing_custom_config_invalid');
  assert.equal(brokenJson.changed, false);
  assert.equal(await fs.readFile(brokenPath, 'utf8'), brokenBefore);
});

test('MCP startup auto-creates a config and health reports real inventory', async (t) => {
  const { fakeHome, project } = await workspace(t, 'setup-mcp-first-run');
  await writeSkillAt(path.join(project, '.claude', 'skills'), 'mcp-visible');
  const session = mcpSession({
    command: process.execPath,
    args: [bin, 'mcp', '--home', fakeHome],
    cwd: project,
  });
  try {
    const init = await session.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'first-run', version: '1' },
    });
    assert.equal(init.result.serverInfo.version, '0.3.0');
    assert.match(init.result.instructions, /list_skills/i);
    assert.match(init.result.instructions, /recommendation/i);
    assert.match(init.result.instructions, /no? ?extra|without another|approval/i);
    session.notify('notifications/initialized', {});
    const tools = await session.request('tools/list', {});
    const names = tools.result.tools.map((tool) => tool.name);
    assert.ok(names.includes('health'));
    assert.deepEqual(session.nonJson, [], 'MCP stdout must not contain setup logs');
    const health = await session.request('tools/call', { name: 'health', arguments: {} });
    const report = JSON.parse(health.result.content[0].text);
    assert.equal(report.status, 'ready');
    assert.equal(report.catalog.counts.skills, 1);
    assert.ok(report.hostIntegrations.some((entry) => entry.host === 'cursor' && entry.configured === false));
    const listed = await session.request('tools/call', { name: 'list_skills', arguments: {} });
    const catalog = JSON.parse(listed.result.content[0].text);
    assert.deepEqual(catalog.skills.map((skill) => skill.name), ['mcp-visible']);
    const configExists = await fs
      .stat(path.join(project, '.skill-conductor', 'config.json'))
      .then(() => true)
      .catch(() => false);
    assert.equal(configExists, true);
  } finally {
    await session.close();
  }
});

test('generated Cursor/WorkBuddy/Qoder/OpenCode configs preserve values and launch real MCP stdio', async (t) => {
  const { fakeHome, project } = await workspace(t, 'setup-hosts');
  await writeSkillAt(path.join(project, '.agents', 'skills'), 'report-builder');
  const secret = 'fixture-secret-value-do-not-print';
  await fs.mkdir(path.join(project, '.cursor'), { recursive: true });
  await fs.writeFile(
    path.join(project, '.cursor', 'mcp.json'),
    `${JSON.stringify({ mcpServers: { keep: { command: 'keep-it', args: [] } }, credential: secret }, null, 2)}\n`,
    'utf8',
  );
  await fs.mkdir(path.join(project, '.workbuddy'), { recursive: true });
  await fs.writeFile(
    path.join(project, '.workbuddy', 'mcp.json'),
    `${JSON.stringify({ mcpServers: { other: { command: 'other', args: ['--x'] } }, token: secret }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(project, '.mcp.json'),
    `${JSON.stringify({ mcpServers: {}, password: secret }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(project, 'opencode.json'),
    `${JSON.stringify({ theme: 'keep', mcp: { servers: { keep: { type: 'local', command: ['keep'] } } }, key: secret }, null, 2)}\n`,
    'utf8',
  );

  for (const host of ['cursor', 'workbuddy', 'qoder', 'opencode']) {
    const result = await setup(project, fakeHome, ['--host', host]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.hostIntegration.status, 'configured');
    assert.equal(result.json.hostIntegration.nativeVerified, false);
    assert.equal(result.json.hostIntegration.verification, 'schema-only');
    assert.ok(!result.stdout.includes(secret), `${host} leaked a credential`);
    assert.ok(!result.stderr.includes(secret), `${host} leaked a credential to stderr`);
  }

  const cursor = JSON.parse(await fs.readFile(path.join(project, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(cursor.mcpServers.keep.command, 'keep-it');
  assert.equal(cursor.credential, secret);
  const cursorHandshake = await handshake(
    cursor.mcpServers.conductor.command,
    cursor.mcpServers.conductor.args,
    project,
  );
  assert.equal(cursorHandshake.serverInfo.version, '0.3.0');
  assert.ok(cursorHandshake.tools.includes('prepare_skills'));
  assert.ok(cursorHandshake.tools.includes('health'));

  const workbuddy = JSON.parse(await fs.readFile(path.join(project, '.workbuddy', 'mcp.json'), 'utf8'));
  assert.equal(workbuddy.mcpServers.other.command, 'other');
  assert.equal(workbuddy.token, secret);
  await handshake(
    workbuddy.mcpServers.conductor.command,
    workbuddy.mcpServers.conductor.args,
    project,
  );

  const qoder = JSON.parse(await fs.readFile(path.join(project, '.mcp.json'), 'utf8'));
  assert.equal(qoder.password, secret);
  await handshake(qoder.mcpServers.conductor.command, qoder.mcpServers.conductor.args, project);

  const opencode = JSON.parse(await fs.readFile(path.join(project, 'opencode.json'), 'utf8'));
  assert.equal(opencode.theme, 'keep');
  assert.equal(opencode.key, secret);
  assert.equal(opencode.mcp.servers.conductor.type, 'local');
  assert.equal(opencode.mcp.servers.conductor.protocol, 'legacy');
  await handshake(
    opencode.mcp.servers.conductor.command[0],
    opencode.mcp.servers.conductor.command.slice(1),
    project,
  );

  const cursorBefore = await fs.readFile(path.join(project, '.cursor', 'mcp.json'), 'utf8');
  const again = await setup(project, fakeHome, ['--host', 'cursor']);
  assert.equal(again.json.hostIntegration.status, 'already_configured');
  assert.equal(again.json.hostIntegration.changed, false);
  assert.equal(await fs.readFile(path.join(project, '.cursor', 'mcp.json'), 'utf8'), cursorBefore);
});

test('an unrelated MCP server named conductor is preserved with a stable unused name', async (t) => {
  const { fakeHome, project } = await workspace(t, 'setup-name-collision');
  await writeSkillAt(path.join(project, '.cursor', 'skills'), 'collision-skill');
  const secret = 'collision-secret-do-not-print';
  const target = path.join(project, '.cursor', 'mcp.json');
  const unrelated = { command: 'someone-elses-server', args: ['--flag'], env: { TOKEN: secret } };
  await fs.writeFile(
    target,
    `${JSON.stringify({ mcpServers: { conductor: unrelated, keep: { command: 'keep', args: [] } } }, null, 2)}\n`,
    'utf8',
  );
  const result = await setup(project, fakeHome, ['--host', 'cursor']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.hostIntegration.status, 'configured');
  assert.equal(result.json.hostIntegration.serverName, 'conductor-skill-conductor');
  assert.equal(result.json.hostIntegration.preservedExistingConductor, true);
  assert.ok(!result.stdout.includes(secret));
  const raw = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.deepEqual(raw.mcpServers.conductor, unrelated);
  assert.ok(raw.mcpServers['conductor-skill-conductor']);
  await handshake(
    raw.mcpServers['conductor-skill-conductor'].command,
    raw.mcpServers['conductor-skill-conductor'].args,
    project,
  );
  const again = await setup(project, fakeHome, ['--host', 'cursor']);
  assert.equal(again.json.hostIntegration.status, 'already_configured');
  assert.equal(again.json.hostIntegration.serverName, 'conductor-skill-conductor');
  const after = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.deepEqual(after.mcpServers.conductor, unrelated);
});

test('DeepSeek Harness writes a Cordis YAML entry, not invented mcpServers JSON', async (t) => {
  const { fakeHome, project } = await workspace(t, 'setup-dsh');
  await writeSkillAt(path.join(project, '.dsh', 'skills'), 'dsh-skill');
  const rootPackagePath = path.join(project, 'package.json');
  const rootPackage = '{\n  "name": "unrelated-user-project",\n  "private": true\n}\n';
  await fs.writeFile(rootPackagePath, rootPackage, 'utf8');
  const result = await setup(project, fakeHome, ['--host', 'deepseek-harness']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.hostIntegration.status, 'native_unverified');
  assert.equal(result.json.hostIntegration.nativeVerified, false);
  assert.equal(result.json.hostIntegration.reloadRequired, true);
  const bundleDir = path.join(project, '.skill-conductor', 'integrations', 'deepseek-harness');
  const patchPath = path.join(bundleDir, 'cordis.patch.yml');
  const text = await fs.readFile(patchPath, 'utf8');
  assert.match(text, /- insert:/);
  assert.match(text, /    - id: mcp-skill-conductor/);
  assert.match(text, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(text, /serverName: skill-conductor/);
  assert.match(text, /transport: stdio/);
  assert.match(text, /failOnStartupError: true/);
  assert.doesNotMatch(text, /"mcpServers"|^\s*mcpServers\s*:/m);
  const bundlePackage = JSON.parse(await fs.readFile(path.join(bundleDir, 'package.json'), 'utf8'));
  assert.equal(bundlePackage.private, true);
  assert.equal(bundlePackage.type, 'module');
  assert.deepEqual(bundlePackage.files, ['cordis.patch.yml']);
  assert.equal(bundlePackage.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(await fs.stat(path.join(project, 'cordis.patch.yml')).then(() => true).catch(() => false), false);
  assert.equal(await fs.readFile(rootPackagePath, 'utf8'), rootPackage);
  const launch = parseCordisCommand(text);
  assert.ok(launch.command);
  assert.deepEqual(launch.args.slice(-3), ['mcp', '--config', path.join(project, '.skill-conductor', 'config.json')]);
  await handshake(launch.command, launch.args, project);

  const again = await setup(project, fakeHome, ['--host', 'deepseek-harness']);
  assert.equal(again.json.hostIntegration.status, 'native_unverified');
  assert.equal(again.json.hostIntegration.changed, false);
});

test('JSONC host configs are preserved and receive an explicit patch instead of a rewrite', async (t) => {
  const { fakeHome, project } = await workspace(t, 'setup-jsonc');
  await writeSkillAt(path.join(project, '.cursor', 'skills'), 'jsonc-skill');
  const secret = 'jsonc-credential-must-not-print';
  const target = path.join(project, '.cursor', 'mcp.json');
  const original = `// user comment\n{\n  "mcpServers": { "keep": { "command": "keep", "args": [] } },\n  "token": "${secret}"\n}\n`;
  await fs.writeFile(target, original, 'utf8');
  const result = await setup(project, fakeHome, ['--host', 'cursor']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.hostIntegration.status, 'patch_required');
  assert.equal(result.json.hostIntegration.nativeVerified, false);
  assert.equal(await fs.readFile(target, 'utf8'), original);
  assert.ok(!result.stdout.includes(secret));
  const patch = JSON.parse(
    await fs.readFile(path.join(project, '.skill-conductor', 'patches', 'cursor.mcp.patch.json'), 'utf8'),
  );
  assert.equal(patch.patch.mcpServers.conductor.command, process.execPath);
  assert.ok(patch.nextAction);

  const jsoncPath = path.join(project, 'opencode.jsonc');
  const jsoncOriginal = `// existing OpenCode JSONC\n{\n  "theme": "keep",\n  "token": "${secret}"\n}\n`;
  await fs.writeFile(jsoncPath, jsoncOriginal, 'utf8');
  const opencode = await setup(project, fakeHome, ['--host', 'opencode']);
  assert.equal(opencode.code, 0, opencode.stderr);
  assert.equal(opencode.json.hostIntegration.status, 'patch_required');
  assert.equal(await fs.readFile(jsoncPath, 'utf8'), jsoncOriginal);
  assert.equal(
    await fs.stat(path.join(project, 'opencode.json')).then(() => true).catch(() => false),
    false,
  );
  assert.ok(!opencode.stdout.includes(secret));
});

test('host-supplied recommendation picks a real English-described user skill for a Chinese request', async (t) => {
  const { fakeHome, project } = await workspace(t, 'setup-host-rec');
  await writeSkillAt(
    path.join(project, '.claude', 'skills'),
    'sales-report',
    'Build a sales report from CSV data with totals and charts',
  );
  const initialized = await setup(project, fakeHome);
  assert.equal(initialized.code, 0, initialized.stderr);
  const recommendationPath = path.join(project, 'recommend.json');
  await fs.writeFile(
    recommendationPath,
    `${JSON.stringify({
      selected: [
        {
          id: 'claude-project:sales-report',
          reason: 'English metadata matches the Chinese sales-report request',
          confidence: 0.93,
        },
      ],
    })}\n`,
    'utf8',
  );
  const routed = await runCli(
    ['route', '请根据销售数据生成带图表的报告', '--recommend', recommendationPath],
    { cwd: project },
  );
  assert.equal(routed.code, 0, routed.stderr);
  const pending = JSON.parse(routed.stdout);
  assert.equal(pending.status, 'awaiting_choice');
  assert.equal(pending.selector.mode, 'host');
  assert.equal(pending.selector.label, 'host-supplied');
  assert.equal(pending.selector.semantic, true);
  assert.deepEqual(pending.recommendation.selected.map((entry) => entry.id), ['claude-project:sales-report']);
  const shown = await runCli(['show', pending.runId], { cwd: project });
  assert.equal(shown.code, 0, shown.stderr);
  const stored = JSON.parse(shown.stdout);
  assert.equal(stored.states.executed, false);
  assert.equal(stored.states.activated, false);
  const config = await readConfig(project);
  assert.equal(config.execution.enabled, false);
  assert.deepEqual(config.execution.trustedSkillIds, []);

  const unknownPath = path.join(project, 'unknown.json');
  await fs.writeFile(
    unknownPath,
    `${JSON.stringify({ selected: [{ id: 'claude-project:invented', reason: 'nope', confidence: 0.9 }] })}\n`,
    'utf8',
  );
  const unknown = await runCli(['route', '请生成报告', '--recommend', unknownPath], { cwd: project });
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /unknown|not found|selected/i);

  await writeSkillAt(
    path.join(project, '.claude', 'skills'),
    'blocked-skill',
    'Requires a host browser capability that is not configured',
  );
  const blockedConfigPath = path.join(project, '.skill-conductor', 'config.json');
  const raw = JSON.parse(await fs.readFile(blockedConfigPath, 'utf8'));
  // Metadata-only capability fixture: setup still never grants trust or executes.
  await fs.writeFile(
    path.join(project, '.claude', 'skills', 'blocked-skill', 'conductor.json'),
    `${JSON.stringify({ requiredCapabilities: ['browser.open'] })}\n`,
    'utf8',
  );
  await fs.writeFile(blockedConfigPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const blockedPath = path.join(project, 'blocked.json');
  await fs.writeFile(
    blockedPath,
    `${JSON.stringify({ selected: [{ id: 'claude-project:blocked-skill', reason: 'nope', confidence: 0.9 }] })}\n`,
    'utf8',
  );
  const blocked = await runCli(['route', '请生成报告', '--recommend', blockedPath], { cwd: project });
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /blocked|capability/i);
});

test('doctor reports runtime, roots, counts and integration/reload state without running a demo', async (t) => {
  const { fakeHome, project } = await workspace(t, 'setup-doctor');
  await writeSkillAt(path.join(project, '.cursor', 'skills'), 'doctor-skill');
  const initialized = await setup(project, fakeHome, ['--host', 'cursor']);
  assert.equal(initialized.code, 0, initialized.stderr);
  const doctor = await runCli(['doctor'], { cwd: project });
  assert.equal(doctor.code, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.status, 'ready');
  assert.equal(report.runtime.status, 'ready');
  assert.equal(report.runtime.node, process.versions.node);
  assert.equal(report.catalog.counts.skills, 1);
  assert.equal(report.roots.length, 1);
  assert.ok(report.hostIntegrations.some((entry) => entry.host === 'cursor' && entry.configured));
  assert.equal(report.demo.includedInUserCatalog, false);
  const artifacts = await fs.stat(path.join(project, '.skill-conductor', 'runs', 'artifacts')).then(() => true).catch(() => false);
  assert.equal(artifacts, false);
});

async function makeSourceArchive(dir) {
  const archive = path.join(dir, 'source-fixture.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', projectRoot, 'package.json', 'bin', 'src'], {
    stdio: 'ignore',
  });
  return archive;
}

test('bootstrap installer uses a local archive, project-local runtime dir, and preserves config', { skip: !['win32', 'linux'].includes(process.platform) }, async (t) => {
  const { dir, fakeHome, project } = await workspace(t, 'installer');
  const archive = await makeSourceArchive(dir);
  if (process.platform === 'win32') {
    const script = path.join(projectRoot, 'install.ps1');
    const result = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-ArchivePath',
        archive,
        '-HomePath',
        fakeHome,
      ],
      { cwd: project, encoding: 'utf8' },
    );
    assert.match(result, /"ok":\s*true/);
    const installedPackage = JSON.parse(
      await fs.readFile(path.join(project, '.skill-conductor', 'app', 'package.json'), 'utf8'),
    );
    assert.equal(installedPackage.version, '0.3.0');
    const config = JSON.parse(
      await fs.readFile(path.join(project, '.skill-conductor', 'config.json'), 'utf8'),
    );
    assert.equal(config.setup.managedBy, 'skill-conductor');
    assert.deepEqual(config.roots, []);
    const cli = path.join(project, '.skill-conductor', 'app', 'bin', 'skill-conductor.mjs');
    assert.equal(await fs.stat(cli).then(() => true), true);

    const fakeNode = path.join(dir, 'fake-node.zip');
    const fakeFile = path.join(dir, 'not-node.txt');
    await fs.writeFile(fakeFile, 'not a node runtime\n', 'utf8');
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -LiteralPath '${fakeFile.replaceAll("'", "''")}' -DestinationPath '${fakeNode.replaceAll("'", "''")}'`,
    ]);
    let failed = null;
    try {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-ArchivePath',
          archive,
          '-NoSetup',
          '-ForcePortableNode',
          '-NodeArchivePath',
          fakeNode,
          '-NodeSha256',
          '0'.repeat(64),
        ],
        { cwd: project, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (error) {
      failed = error;
    }
    assert.ok(failed, 'installer must fail a bad portable Node hash');
    const output = `${failed.stdout ?? ''}${failed.stderr ?? ''}`;
    assert.match(output.replace(/\s+/g, ' '), /SHA256/i);
    assert.match(output.replace(/\s+/g, ' '), /mism\s*atch/i);
    const runtimeExists = await fs.stat(path.join(project, '.skill-conductor', 'runtime')).then(() => true).catch(() => false);
    assert.equal(runtimeExists, false);

    const traversalZip = path.join(dir, 'traversal.zip');
    const traversalScript = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open('${traversalZip.replaceAll("'", "''")}', 'Create')
$entry = $zip.CreateEntry('../escaped.txt')
$writer = New-Object System.IO.StreamWriter($entry.Open())
$writer.Write('escape')
$writer.Dispose()
$zip.Dispose()
`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', traversalScript]);
    let traversalFailed = null;
    try {
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ArchivePath', traversalZip, '-NoSetup'],
        { cwd: project, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (error) {
      traversalFailed = error;
    }
    assert.ok(traversalFailed, 'installer must reject traversal archive entries');
    assert.match(
      `${traversalFailed.stdout ?? ''}${traversalFailed.stderr ?? ''}`.replace(/\s+/g, ' '),
      /unsafe|traversal/i,
    );
    assert.equal(await fs.stat(path.join(dir, 'escaped.txt')).then(() => true).catch(() => false), false);
    assert.equal(await fs.stat(path.join(project, '.skill-conductor', 'escaped.txt')).then(() => true).catch(() => false), false);
  } else {
    const result = execFileSync(
      'sh',
      [path.join(projectRoot, 'install.sh'), '--project', project, '--archive', archive, '--home', fakeHome],
      { cwd: project, encoding: 'utf8' },
    );
    assert.match(result, /setupRan=true/);
    const installedPackage = JSON.parse(
      await fs.readFile(path.join(project, '.skill-conductor', 'app', 'package.json'), 'utf8'),
    );
    assert.equal(installedPackage.version, '0.3.0');
    const config = JSON.parse(
      await fs.readFile(path.join(project, '.skill-conductor', 'config.json'), 'utf8'),
    );
    assert.equal(config.setup.managedBy, 'skill-conductor');
  }
});
