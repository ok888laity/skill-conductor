#!/usr/bin/env node
/**
 * Offline replay of recorded empty selections to verify the ask no_match gate.
 * No model calls: the recorded recommendation is supplied as a selector callback.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, prepareTask } from '../src/index.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auditDir = path.join(projectRoot, 'integration-audit');

async function main() {
  const routing = JSON.parse(await fs.readFile(path.join(auditDir, 'live-routing.json'), 'utf8'));
  const config = await loadConfig(path.join(projectRoot, 'integration-temp', 'live', 'config.opencode.json'));
  const results = [];
  for (const entry of routing.results) {
    if ((entry.selected ?? []).length > 0) continue;
    const abstainReason = entry.recommendation?.abstainReason || 'recorded empty selection';
    const prepared = await prepareTask({
      config,
      task: entry.task,
      mode: 'ask',
      intent: 'route',
      selector: async () => ({ selected: [], abstainReason }),
    });
    results.push({
      caseId: entry.caseId,
      recordedStatus: entry.status,
      replayedStatus: prepared.run.status,
      pendingChoice: prepared.pendingChoice,
      awaitingChoice: prepared.run.states.awaitingChoice,
      noMatch: prepared.run.states.noMatch,
      activated: prepared.run.states.activated,
      executed: prepared.run.states.executed,
      abstainReason: prepared.run.recommendation.abstainReason,
      pass: prepared.run.status === 'no_match'
        && prepared.pendingChoice === null
        && prepared.run.states.awaitingChoice === false
        && prepared.run.states.activated === false
        && prepared.run.states.executed === false,
    });
  }
  const report = {
    label: 'OFFLINE GATE REPLAY; no model calls',
    total: results.length,
    passed: results.filter((item) => item.pass).length,
    failed: results.filter((item) => !item.pass).length,
    results,
  };
  await fs.writeFile(path.join(auditDir, 'gate-replay.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed }, null, 2)}\n`);
  if (report.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
