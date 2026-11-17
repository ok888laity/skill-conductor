#!/usr/bin/env node
/**
 * Generic event-aware before-each-agent-step integration.
 *
 * The host supplies explicit task/session identity and an event. The adaptive
 * gate may trigger, suppress, reuse or return the same pending choice. Ask policy
 * is kept: nothing is activated or executed until the host records an owner
 * decision. Run with:
 *   node examples/sdk-before-each-step.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { prepareTask } from '../src/router.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await loadConfig(path.join(root, 'examples', 'config.demo.json'));

const session = {
  taskId: 'example-task-001',
  sessionId: 'example-host-session',
  task: '分析销售 CSV 数据，整理关键指标，然后生成 Markdown 报告。',
  phase: 'inspect-data',
  observations: [],
  step: 0,
  event: 'new_task',
};

for (let index = 0; index < 3; index += 1) {
  session.step += 1;
  const { run, pendingChoice, trigger } = await prepareTask({
    config,
    task: session.task,
    taskId: session.taskId,
    sessionId: session.sessionId,
    event: session.event,
    phase: session.phase,
    observations: session.observations,
    activity: {
      // Host hints only; this example does not pretend to observe every agent action.
      needsSkill: index === 0,
      requirementsKey: 'sales-report-v1',
    },
    intent: 'run',
  });
  console.log(
    JSON.stringify(
      {
        step: session.step,
        taskId: session.taskId,
        event: session.event,
        phase: session.phase,
        trigger,
        runId: run.runId,
        status: run.status,
        reused: run.reused ?? false,
        executedForThisEvent: run.executedForThisEvent ?? false,
        sourceRunId: run.sourceRunId ?? null,
        recommendation: run.recommendation,
        pending: Boolean(pendingChoice),
        next:
          run.status === 'awaiting_choice'
            ? `Owner decision required, e.g. skill-conductor.cmd choose ${run.runId} --config examples/config.demo.json --skills ...`
            : run.status === 'suppressed' || run.status === 'reused' || run.status === 'disabled'
              ? 'continue host work with existing context; no new execution happened'
              : 'continue',
      },
      null,
      2,
    ),
  );
  if (pendingChoice) break; // do not bypass the owner decision
  session.event = 'routine_continuation';
  session.observations.push(`step ${session.step} completed without inventing approval`);
}
