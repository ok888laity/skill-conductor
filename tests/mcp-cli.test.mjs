import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { makeTempDir, makeConfig, writeSkill, writeConfigFile, projectRoot } from './helpers.mjs';

const bin = path.join(projectRoot, 'bin', 'skill-conductor.mjs');

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: projectRoot,
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

function mcpClient(configPath) {
  const child = spawn(process.execPath, [bin, 'mcp', '--config', configPath], {
    cwd: projectRoot,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = '';
  let nextId = 1;
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  rl.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    }
  });
  const closed = new Promise((resolve) => child.on('close', resolve));
  return {
    get stderr() {
      return stderr;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    request(method, params) {
      const id = nextId;
      nextId += 1;
      const payload = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}; stderr=${stderr}`));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
      });
    },
    async close() {
      child.stdin.end();
      await closed;
    },
  };
}

async function cliFixture(t, options = {}) {
  const dir = await makeTempDir(t, 'cli');
  await writeSkill(dir, {
    name: 'calculate',
    triggers: ['calculate', '计算'],
    script: "process.stdout.write(JSON.stringify({actual:42}));",
  });
  const { config, raw } = await makeConfig(dir, { skills: ['calculate'], ...options });
  const configPath = await writeConfigFile(dir, raw);
  return { dir, config, configPath };
}

test('CLI route emits awaiting_choice and a separate CLI process can choose and execute', async (t) => {
  const f = await cliFixture(t);
  const routed = await runNode(['run', '请计算', '--config', f.configPath]);
  assert.equal(routed.code, 0, routed.stderr);
  const pending = JSON.parse(routed.stdout);
  assert.equal(pending.status, 'awaiting_choice');
  assert.equal(pending.runId.startsWith('run-'), true);
  assert.equal(pending.options.skip, true);

  const chosen = await runNode([
    'choose',
    pending.runId,
    '--config',
    f.configPath,
    '--skills',
    'fixture:calculate',
  ]);
  assert.equal(chosen.code, 0, chosen.stderr);
  const run = JSON.parse(chosen.stdout);
  assert.equal(run.status, 'executed');
  assert.equal(JSON.parse(run.execution.steps[0].stdout).actual, 42);
  assert.equal(run.states.independentlyVerified, false);

  const shown = await runNode(['show', pending.runId, '--config', f.configPath]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).status, 'executed');
});

test('CLI and MCP expose no_match instead of an empty approval prompt', async (t) => {
  const f = await cliFixture(t);
  const routed = await runNode(['route', '明天天气怎么样', '--config', f.configPath]);
  assert.equal(routed.code, 0, routed.stderr);
  const noMatch = JSON.parse(routed.stdout);
  assert.equal(noMatch.status, 'no_match');
  assert.equal(noMatch.pendingChoice, undefined);
  assert.equal(noMatch.states.awaitingChoice, false);
  assert.equal(noMatch.states.executed, false);
  assert.match(noMatch.recommendation.abstainReason, /no|match|evidence/i);

  const client = mcpClient(f.configPath);
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    client.notify('notifications/initialized', {});
    const prepared = await client.request('tools/call', {
      name: 'prepare_skills',
      arguments: { task: '明天天气怎么样' },
    });
    const run = JSON.parse(prepared.result.content[0].text);
    assert.equal(run.status, 'no_match');
    assert.equal(run.states.executed, false);
    assert.equal(run.activation, null);
  } finally {
    await client.close();
  }
});

test('MCP stdio initializes, lists tools, prepares pending choice, and cannot self-approve', async (t) => {
  const f = await cliFixture(t, { mcpAllowExecution: true });
  const client = mcpClient(f.configPath);
  try {
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(init.result.serverInfo.name, 'skill-conductor');
    client.notify('notifications/initialized', {});

    const list = await client.request('tools/list', {});
    const names = list.result.tools.map((tool) => tool.name);
    assert.ok(names.includes('prepare_skills'));
    assert.ok(names.includes('activate_run'));
    assert.ok(!names.some((name) => /approve|decide|mode|auto/i.test(name)), names.join(','));

    const prepared = await client.request('tools/call', {
      name: 'prepare_skills',
      arguments: { task: '请计算' },
    });
    const pending = JSON.parse(prepared.result.content[0].text);
    assert.equal(pending.status, 'awaiting_choice');
    assert.equal(pending.candidates[0].id, 'fixture:calculate');

    const before = await client.request('tools/call', {
      name: 'activate_run',
      arguments: { runId: pending.runId },
    });
    const stillPending = JSON.parse(before.result.content[0].text);
    assert.equal(stillPending.status, 'awaiting_choice');
    assert.equal(stillPending.activation, undefined);

    const chosen = await runNode([
      'choose',
      pending.runId,
      '--config',
      f.configPath,
      '--skills',
      'fixture:calculate',
    ]);
    assert.equal(chosen.code, 0, chosen.stderr);
    assert.equal(JSON.parse(chosen.stdout).status, 'executed');

    const activated = await client.request('tools/call', {
      name: 'activate_run',
      arguments: { runId: pending.runId },
    });
    const context = JSON.parse(activated.result.content[0].text);
    assert.equal(context.status, 'executed');
    assert.match(context.context.skills[0].body, /Fixture instruction body/);

    const unknown = await client.request('tools/call', {
      name: 'approve_run',
      arguments: { runId: pending.runId },
    });
    assert.equal(unknown.error.code, -32602);
  } finally {
    await client.close();
  }
});

test('MCP auto config without mcp.allowExecution routes but never executes', async (t) => {
  const f = await cliFixture(t, { auto: true, mcpAllowExecution: false });
  const client = mcpClient(f.configPath);
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    client.notify('notifications/initialized', {});
    const prepared = await client.request('tools/call', {
      name: 'prepare_skills',
      arguments: { task: '请计算' },
    });
    const run = JSON.parse(prepared.result.content[0].text);
    assert.equal(run.status, 'activated');
    assert.equal(run.states.executed, false);
    assert.equal(run.execution.status, 'not_requested');
  } finally {
    await client.close();
  }
});

test('interactive command refuses non-TTY use instead of treating silence as approval', async (t) => {
  const f = await cliFixture(t);
  const result = await runNode(['interactive', '--config', f.configPath]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /TTY/i);
});
