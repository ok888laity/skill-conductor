import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { normalizeConfig, discoverCatalog, rankLexical, selectRecommendation } from '../src/index.mjs';
import { makeTempDir, makeConfig, writeSkill } from './helpers.mjs';

const SECRET_ENV = 'SKILL_CONDUCTOR_TEST_HTTP_KEY';
const SECRET = 'synthetic-key-that-must-never-be-logged-123456789';

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseURL: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function fixture(t, baseURL) {
  const dir = await makeTempDir(t, 'http-selector');
  await writeSkill(dir, { name: 'calculate', triggers: ['calculate', '计算'] });
  const { raw } = await makeConfig(dir, { skills: ['calculate'] });
  raw.selector = {
    mode: 'http',
    baseURL,
    model: 'mock-model',
    apiKeyEnv: SECRET_ENV,
    timeoutMs: 5000,
  };
  const config = await normalizeConfig(raw);
  const catalog = await discoverCatalog(config);
  const ranking = rankLexical({ skills: catalog.skills, query: '请计算 6*7', smallCatalogAll: true });
  return { config, catalog, ranking };
}

test('HTTP selector accepts a bounded valid response', async (t) => {
  const previous = process.env[SECRET_ENV];
  process.env[SECRET_ENV] = SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = previous;
  });
  const { server, baseURL } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            selected: [{ id: 'fixture:calculate', reason: 'mock selector', confidence: 0.9 }],
            notes: `mock echoed ${SECRET}`,
          }),
        },
      }],
    }));
  });
  t.after(() => close(server));
  const f = await fixture(t, baseURL);
  const result = await selectRecommendation({
    config: f.config,
    catalog: f.catalog,
    ranking: f.ranking,
    materials: { items: [], errors: [] },
    task: '请计算 6*7',
  });
  assert.equal(result.selected[0].id, 'fixture:calculate');
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('HTTP selector rejects an oversized response stream', async (t) => {
  const previous = process.env[SECRET_ENV];
  process.env[SECRET_ENV] = SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = previous;
  });
  const { server, baseURL } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(Buffer.alloc(4 * 1024 * 1024 + 4096, 0x20));
  });
  t.after(() => close(server));
  const f = await fixture(t, baseURL);
  await assert.rejects(
    () => selectRecommendation({
      config: f.config,
      catalog: f.catalog,
      ranking: f.ranking,
      materials: { items: [], errors: [] },
      task: '请计算 6*7',
    }),
    /exceeded 4194304 bytes/i,
  );
});

test('HTTP error serialization redacts the configured API key even without a generic pattern', async (t) => {
  const previous = process.env[SECRET_ENV];
  process.env[SECRET_ENV] = SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = previous;
  });
  const { server, baseURL } = await listen((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `provider echoed credential ${SECRET}` }));
  });
  t.after(() => close(server));
  const f = await fixture(t, baseURL);
  let caught = null;
  try {
    await selectRecommendation({
      config: f.config,
      catalog: f.catalog,
      ranking: f.ranking,
      materials: { items: [], errors: [] },
      task: '请计算 6*7',
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'expected the mock provider error to reject');
  assert.equal(JSON.stringify(caught).includes(SECRET), false);
  assert.match(JSON.stringify(caught), /REDACTED/);
});
