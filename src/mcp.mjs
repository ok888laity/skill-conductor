import readline from 'node:readline';
import { toErrorObject } from './errors.mjs';
import { getRun, listSkills, pendingView, prepareTask, resumeRun } from './router.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'skill-conductor', version: '0.1.0' };

const TOOLS = [
  {
    name: 'list_skills',
    description: 'Discover SKILL.md metadata from configured roots. Read-only; no bodies or scripts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'prepare_skills',
    description:
      'Rank and recommend skills for a task and explicit materials. In ask policy this returns awaiting_choice when a skill is applicable, or no_match when the selector abstains; it never loads bodies or executes. Display choices to the owner; this tool cannot approve them.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'User task text' },
        files: { type: 'array', items: { type: 'string' }, description: 'Explicit local material file paths' },
        phase: { type: 'string', description: 'Current workflow phase' },
        observations: { type: 'array', items: { type: 'string' }, description: 'New observations for rerouting' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_run',
    description: 'Read a persisted run record, including approval state. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'activate_run',
    description:
      'Load chosen skill bodies and resources for an already owner-approved run. Returns awaiting_choice unchanged when approval is still missing. This tool cannot approve or change mode.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_resource',
    description:
      'Read one resource declared by a skill in an activated run. Bounded and restricted to the activated skill directory.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        skillId: { type: 'string' },
        resource: { type: 'string', description: 'Declared relative resource reference' },
      },
      required: ['runId', 'skillId', 'resource'],
      additionalProperties: false,
    },
  },
];

function textResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function callTool(config, name, args) {
  if (name === 'list_skills') return textResult(await listSkills({ config }));
  if (name === 'prepare_skills') {
    const result = await prepareTask({
      config,
      task: args.task,
      files: args.files ?? [],
      phase: args.phase ?? null,
      observations: args.observations ?? [],
      // Mode intentionally comes only from trusted config; it is not a tool argument.
      // MCP execution requires an explicit mcp.allowExecution opt-in; otherwise a
      // trusted auto config may route/activate but must not run scripts.
      intent: config.mcp.allowExecution && config.execution.enabled ? 'run' : 'route',
    });
    return textResult(result.pendingChoice ?? result.run);
  }
  if (name === 'get_run') return textResult(await getRun({ config, runId: args.runId }));
  if (name === 'activate_run') {
    const run = await getRun({ config, runId: args.runId });
    if (run.status === 'awaiting_choice') return textResult(pendingView(run));
    if (run.activation) return textResult({ status: run.status, context: run.context });
    if (!run.decision) return textResult({ status: run.status, message: 'run has no owner decision yet' });
    const activated = await resumeRun({ config, runId: args.runId, executeAllowed: false, claimedBy: 'mcp-activate' });
    return textResult({ status: activated.status, context: activated.context, plan: activated.plan });
  }
  if (name === 'read_resource') {
    const run = await getRun({ config, runId: args.runId });
    if (!run.activation) {
      return textResult({ error: 'run is not activated; an owner decision is required first' }, true);
    }
    const skill = run.activation.skills.find((entry) => entry.id === args.skillId);
    if (!skill) return textResult({ error: `skill is not part of this activated run: ${args.skillId}` }, true);
    const resource = skill.resources.find((entry) => entry.ref === args.resource);
    if (!resource) {
      return textResult(
        { error: `resource is not declared by ${args.skillId}: ${args.resource}`, declared: skill.resources.map((item) => item.ref) },
        true,
      );
    }
    return textResult(resource);
  }
  return textResult({ error: `unknown tool: ${name}` }, true);
}

/**
 * Minimal MCP stdio adapter: newline-delimited JSON-RPC 2.0, tools only.
 * stdout is reserved for protocol messages; diagnostics go to stderr.
 */
export async function startMcpServer({ config }) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  let closed = false;

  const send = (message) => {
    if (closed) return;
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const handle = async (line) => {
    if (line.length > config.mcp.maxInputBytes) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'input exceeds size limit' } });
      return;
    }
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
      return;
    }
    const { id, method, params } = request;
    const isNotification = id === undefined || id === null;
    try {
      if (method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          },
        });
        return;
      }
      if (method === 'notifications/initialized' || method === 'initialized') return;
      if (method === 'ping') {
        if (!isNotification) send({ jsonrpc: '2.0', id, result: {} });
        return;
      }
      if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        return;
      }
      if (method === 'tools/call') {
        const name = params?.name;
        const args = params?.arguments ?? {};
        if (typeof name !== 'string' || !TOOLS.some((tool) => tool.name === name)) {
          send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${String(name)}` } });
          return;
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          send({ jsonrpc: '2.0', id, result: textResult({ error: 'arguments must be an object' }, true) });
          return;
        }
        const result = await callTool(config, name, args);
        send({ jsonrpc: '2.0', id, result });
        return;
      }
      if (!isNotification) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } });
      }
    } catch (error) {
      const detail = toErrorObject(error);
      if (!isNotification) send({ jsonrpc: '2.0', id, result: textResult({ error: detail }, true) });
      else process.stderr.write(`${JSON.stringify(detail)}\n`);
    }
  };

  for await (const line of input) {
    if (line.trim() === '') continue;
    chain = chain.then(() => handle(line)).catch((error) => {
      process.stderr.write(`${JSON.stringify(toErrorObject(error))}\n`);
    });
  }
  await chain;
  closed = true;
}
