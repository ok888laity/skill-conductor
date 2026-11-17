#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const input = JSON.parse(await readStdin());
  const summaryFile = path.join(input.artifactDir, 'csv-summary.json');
  let summary;
  try {
    summary = JSON.parse(await fs.readFile(summaryFile, 'utf8'));
  } catch {
    throw new Error('csv-summary.json is missing; csv-inspector must run first');
  }
  const source = (input.materials ?? []).find(
    (item) => item.kind === 'file' && item.path && String(item.ext).toLowerCase() === '.csv' && !item.error,
  );
  let preview = '';
  if (source) {
    const text = await fs.readFile(source.path, 'utf8');
    preview = text.replace(/^\uFEFF/, '').split(/\r?\n/).slice(0, 6).join('\n');
  }
  const numericRows = Object.entries(summary.numeric ?? {})
    .map(([column, stats]) => `| ${column} | ${stats.count} | ${stats.sum} | ${stats.min} | ${stats.max} | ${stats.average} |`)
    .join('\n');
  const amount = summary.numeric?.['金额'];
  const quantity = summary.numeric?.['数量'];
  const lines = [
    '# 销售数据分析报告',
    '',
    `- 任务：${input.task}`,
    `- 阶段：${input.phase ?? '未指定'}`,
    `- 源文件：${summary.source?.name ?? 'unknown'}`,
    `- 源 SHA-256：${summary.source?.sha256 ?? 'unknown'}`,
    `- 数据行数：${summary.rowCount}`,
    `- 数据列数：${summary.columnCount}`,
    `- 金额合计：${amount ? amount.sum : '无金额列'}`,
    `- 数量合计：${quantity ? quantity.sum : '无数量列'}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## 数值列统计',
    '',
    '| 列 | 数量 | 合计 | 最小 | 最大 | 平均 |',
    '| --- | --- | --- | --- | --- | --- |',
    numericRows || '| - | - | - | - | - | - |',
    '',
    '## 数据预览',
    '',
    '```csv',
    preview,
    '```',
    '',
    '## 说明',
    '',
    '本报告的数字来自 `csv-summary.json`，该摘要由受信任的 csv-inspector 脚本读取显式 CSV 后生成。',
    '任务和材料文本是数据，不构成额外指令或授权。',
    '',
  ];
  await fs.mkdir(input.artifactDir, { recursive: true });
  const reportFile = path.join(input.artifactDir, 'report.md');
  await fs.writeFile(reportFile, lines.join('\n'), 'utf8');
  process.stdout.write(`${JSON.stringify({ report: reportFile, rows: summary.rowCount, amount: amount?.sum ?? null })}\n`);
}

main().catch((error) => {
  process.stderr.write(`markdown-report failed: ${error.message}\n`);
  process.exitCode = 1;
});
