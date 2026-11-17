#!/usr/bin/env node
/**
 * Sanitised public report generator. Reads local integration evidence and emits
 * only aggregate/case labels, with no machine paths, raw logs, session IDs or
 * third-party skill bodies. Development/integration testing, not a benchmark.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auditDir = path.join(projectRoot, 'integration-audit');
const docsDir = path.join(projectRoot, 'docs');

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function readJsonl(file) {
  try {
    return (await fs.readFile(file, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function routingOutcome(entry) {
  if (entry.outcome?.pass === false) return entry.outcome.kind;
  if (entry.expected?.negative) return 'abstained';
  if (entry.expected?.blocked) return 'abstained-missing-capability';
  if (entry.expected?.injection) return entry.status === 'no_match' ? 'no-match-consent-preserved' : 'pending-consent-preserved';
  return 'matched';
}

async function main() {
  const routing = await readJson(path.join(auditDir, 'live-routing.json'));
  const downstream = await readJson(path.join(auditDir, 'live-downstream-revalidated.json'));
  const ledger = await readJsonl(path.join(auditDir, 'live-call-ledger.jsonl'));
  const catalog = await readJson(path.join(auditDir, 'live-catalog.json'));
  let gateReplay = null;
  try {
    gateReplay = await readJson(path.join(auditDir, 'gate-replay.json'));
  } catch {
    gateReplay = null;
  }
  const invocations = ledger.filter((entry) => entry.invocation !== false);
  const excludedMarkers = ledger.filter((entry) => entry.invocation === false);

  const routingCases = routing.results.map((entry) => ({
    caseId: entry.caseId,
    category: entry.category,
    mode: entry.mode,
    selected: entry.selected ?? [],
    expected: entry.expected,
    outcome: routingOutcome(entry),
    passed: entry.ok === true,
    latencyMs: entry.latencyMs,
  }));
  const downstreamCases = downstream.results.map((entry) => ({
    caseId: entry.caseId,
    category: entry.category,
    mode: entry.mode,
    requestedSkills: entry.requestedSkills,
    sessionCount: entry.sessions?.length ?? 0,
    expectedSkillLoads: (entry.sessions ?? []).filter((session) => session.loadedExpectedSkill).length,
    checks: (entry.validation?.checks ?? []).map((check) => ({ name: check.name, pass: check.pass === true })),
    verified: entry.verified === true,
    postVerificationStatus: entry.postVerificationStatus ?? entry.status,
    revalidated: Boolean(entry.revalidatedAt),
    latencyMs: entry.latencyMs,
    errors: (entry.errors ?? []).map((error) => error.message),
  }));

  const report = {
    schema: 'skill-conductor/live-integration-report/v0.1',
    label: 'DEVELOPMENT/INTEGRATION TESTING — not an accuracy benchmark or held-out evaluation',
    generatedAt: new Date().toISOString(),
    model: routing.model,
    sourceCommits: Object.values(
      catalog.skills.reduce((acc, item) => {
        acc[item.repo] = { repo: item.repo, commit: item.commit };
        return acc;
      }, {}),
    ),
    methodology: {
      routing: '21 OpenCode-selector cases through the project selector adapter; small-catalog roster; ask mode; no activation from route-only cases.',
      downstream: '6 downstream cases through the project SDK host executor; isolated OpenCode build sessions with native local skills arrays; executor prompt requires the built-in skill tool; independent verifier reads actual artifacts and saved raw tool events.',
      consent: 'At least one downstream case prepared in ask mode, showed pending and zero executor calls, then a trusted harness choice resumed it.',
      callAccounting: 'Counts are OpenCode run/session invocations, not underlying provider turns. Repeated/internal provider turns inside one agent session are not counted separately.',
    },
    calls: {
      sessionInvocations: invocations.length,
      excludedNonInvocationMarkers: excludedMarkers.length,
      byKind: invocations.reduce((acc, entry) => {
        acc[entry.kind] = (acc[entry.kind] ?? 0) + 1;
        return acc;
      }, {}),
      note: 'Includes two controller preflight sessions and one developer routing pilot. No hidden retries.',
    },
    routing: {
      total: routingCases.length,
      passed: routingCases.filter((item) => item.passed).length,
      failed: routingCases.filter((item) => !item.passed).length,
      abstained: routingCases.filter((item) => ['abstained', 'abstained-missing-capability'].includes(item.outcome)).length,
      noMatchGateReplay: gateReplay
        ? { total: gateReplay.total, passed: gateReplay.passed, failed: gateReplay.failed, modelCalls: 0 }
        : null,
      cases: routingCases,
    },
    downstream: {
      total: downstreamCases.length,
      passed: downstreamCases.filter((item) => item.verified).length,
      failed: downstreamCases.filter((item) => !item.verified).length,
      sessions: downstreamCases.reduce((sum, item) => sum + item.sessionCount, 0),
      cases: downstreamCases,
    },
    preservedFindings: [
      'First-pass offline verifier treated PowerShell-wrapped tests as exit 0 because the wrapper process exited 0; saved raw events showed the real RED then GREEN. Revalidated offline with effective EXITCODE parsing and no new model call.',
      'One budget-accounting defect double-counted four downstream cases; the ledger now marks those rows as non-invocation markers instead of deleting history.',
      'An early blocked-capability classifier passed for the wrong reason; the corrected classification uses the recorded abstainReason naming the missing capability.',
      'The original 21-row run predates the ask no_match gate: empty selections were recorded as awaiting_choice. An offline replay of the same four empty selections verifies the fixed gate with zero model calls.',
    ],
    limitations: [
      'Small synthetic integration set; not production accuracy evidence.',
      'No claim that the selector always chooses the intended skill.',
      'Execution is not an OS sandbox.',
      'Third-party skill packages are test inputs only and are not vendored in this repository.',
      'Windows was the actual live-test platform in this run; CI covers offline tests on Windows and Linux without live model calls.',
    ],
  };

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(
    path.join(docsDir, 'live-integration-results.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );

  const lines = [
    '# Live integration results (development testing)',
    '',
    'This is **development/integration testing**, not an accuracy benchmark or held-out evaluation.',
    `Model: \`${report.model}\`. OpenCode sessions counted: ${report.calls.sessionInvocations}.`,
    '',
    '## Routing',
    '',
    `21 cases through the project OpenCode selector adapter: ${report.routing.passed} passed, ${report.routing.abstained} abstained, ${report.routing.failed} failed.`,
    gateReplay ? `Offline no-match gate replay of recorded empty selections: ${gateReplay.passed}/${gateReplay.total} passed, zero model calls.` : '',
    '',
    '| Case | Category | Selected | Outcome |',
    '| --- | --- | --- | --- |',
    ...routingCases.map((item) => `| ${item.caseId} | ${item.category} | ${item.selected.join(', ') || '(none)'} | ${item.outcome} |`),
    '',
    '## Downstream executions',
    '',
    `6 cases through the project SDK executor and real isolated OpenCode build sessions: ${report.downstream.passed} independently verified, ${report.downstream.failed} failed, ${report.downstream.sessions} sessions.`,
    '',
    '| Case | Category | Sessions | Checks | Post-verifier state |',
    '| --- | --- | --- | --- | --- |',
    ...downstreamCases.map((item) => `| ${item.caseId} | ${item.category} | ${item.sessionCount} | ${item.checks.filter((check) => check.pass).length}/${item.checks.length} | ${item.postVerificationStatus} |`),
    '',
    '## Method notes',
    '',
    ...Object.values(report.methodology).map((text) => `- ${text}`),
    '',
    '## Preserved findings',
    '',
    ...report.preservedFindings.map((text) => `- ${text}`),
    '',
    '## Limitations',
    '',
    ...report.limitations.map((text) => `- ${text}`),
    '',
  ];
  await fs.writeFile(path.join(docsDir, 'live-integration.md'), lines.join('\n'), 'utf8');
  process.stdout.write(`${JSON.stringify({
    routing: report.routing.total,
    downstream: report.downstream.total,
    sessions: report.calls.sessionInvocations,
    excludedMarkers: report.calls.excludedNonInvocationMarkers,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
