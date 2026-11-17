#!/usr/bin/env node
/**
 * Generic before-each-agent-step integration. Ask policy is kept: each step gets
 * a fresh route, but nothing is activated or executed until the host records an
 * owner decision. Run with:
 *   node examples/sdk-before-each-step.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { prepareTask } from '../src/router.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await loadConfig(path.join(root, 'examples', 'config.demo.json'));

const session = {
  task: '分析销售 CSV 数据，整理关键指标，然后生成 Markdown 报告。',
  observations: [],
  step: 0,
};

for (const phase of ['inspect-data', 'reporting']) {
  session.step += 1;
  const { run, pendingChoice } = await prepareTask({
    config,
    task: session.task,
    phase,
    observations: session.observations,
    // Default "run" intent, but ask policy still requires a separate owner choice.
    intent: 'run',
  });
  console.log(
    JSON.stringify(
      {
        step: session.step,
        phase,
        runId: run.runId,
        status: run.status,
        selector: run.selector,
        recommendation: run.recommendation,
        pending: Boolean(pendingChoice),
        next:
          run.status === 'awaiting_choice'
            ? `Owner decision required, e.g. skill-conductor.cmd choose ${run.runId} --config examples/config.demo.json --skills ...`
            : 'continue',
      },
      null,
      2,
    ),
  );
  // A real host would append observations gathered by the step before rerouting.
  session.observations.push(`phase ${phase} completed; no approval was fabricated by the SDK example`);
  if (pendingChoice) break; // do not bypass the owner decision
}
