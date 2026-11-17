#!/usr/bin/env node
/**
 * Small offline dev eval. It exercises the lexical ranking only and uses
 * synthetic skill metadata. It is not a semantic-model benchmark and must not
 * be quoted as accuracy evidence for a live selector.
 */
import { rankLexical } from '../src/lexical.mjs';

function skill(id, name, description, triggers, extra = {}) {
  return {
    id,
    name,
    description,
    tags: extra.tags ?? [],
    triggers,
    avoidTriggers: extra.avoidTriggers ?? [],
    whenToUse: extra.whenToUse ?? '',
    requiredCapabilities: [],
    dependencies: [],
    conflicts: [],
    resources: [],
    executable: null,
    valid: true,
    sha256: '0'.repeat(64),
    sidecarSha256: null,
    rootTrusted: true,
    ambiguousName: false,
  };
}

const skills = [
  skill('eval:csv', 'csv-inspector', 'Read CSV sales files and compute row, column and numeric statistics.', [
    'CSV',
    '销售数据',
    '表格',
    '金额汇总',
    'sales data',
  ]),
  skill('eval:report', 'markdown-report', 'Generate a Markdown report or summary from available data.', [
    'Markdown 报告',
    '生成报告',
    'report',
    '总结',
  ], { avoidTriggers: ['不要生成报告'] }),
  skill('eval:review', 'code-review', 'Review code changes for correctness and security risks.', [
    'code review',
    '代码审查',
    'review',
  ]),
];

const cases = [
  { name: 'zh-csv', query: '帮我统计这个销售数据的金额汇总', expect: 'eval:csv' },
  { name: 'en-csv', query: 'inspect this CSV sales data', expect: 'eval:csv' },
  { name: 'zh-report', query: '根据结果生成 Markdown 报告并总结', expect: 'eval:report' },
  { name: 'en-report', query: 'write a markdown report', expect: 'eval:report' },
  { name: 'zh-review', query: '请做代码审查', expect: 'eval:review' },
  { name: 'en-review', query: 'review this patch', expect: 'eval:review' },
  { name: 'no-match', query: 'what is the weather tomorrow', expect: null },
  { name: 'avoid-trigger', query: '不要生成报告', expect: null },
];

const results = cases.map((entry) => {
  const ranked = rankLexical({ skills, query: entry.query, minScore: 0.8 });
  const top = ranked.candidates.find((candidate) => !candidate.blocked)?.id ?? null;
  const abstained = Boolean(ranked.abstainReason);
  const pass = entry.expect === null ? top === null || abstained : top === entry.expect;
  return {
    case: entry.name,
    query: entry.query,
    expected: entry.expect,
    top,
    abstained,
    pass,
    mode: ranked.label,
  };
});

const passed = results.filter((entry) => entry.pass).length;
const report = {
  schema: 'skill-conductor/dev-eval/v0.1',
  label: 'synthetic-lexical-fixtures',
  note: 'Offline lexical dev eval only. Not semantic accuracy, not a benchmark, not live-model evidence.',
  total: results.length,
  passed,
  failed: results.length - passed,
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (passed !== results.length) process.exitCode = 1;
