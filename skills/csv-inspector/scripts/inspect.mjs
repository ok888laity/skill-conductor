#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((entry) => !(entry.length === 1 && entry[0].trim() === ''));
}

function isNumeric(value) {
  if (value === undefined || String(value).trim() === '') return false;
  return Number.isFinite(Number(String(value).replaceAll(',', '')));
}

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
  const file = (input.materials ?? []).find(
    (item) => item.kind === 'file' && item.path && String(item.ext).toLowerCase() === '.csv' && !item.error,
  );
  if (!file) throw new Error('no readable CSV material was provided');
  const stat = await fs.stat(file.path);
  if (stat.size > 5 * 1024 * 1024) throw new Error('CSV exceeds the demo 5 MiB limit');
  const text = await fs.readFile(file.path, 'utf8');
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('CSV is empty');
  const headers = rows[0].map((header, index) => header.trim() || `column_${index + 1}`);
  const records = rows.slice(1).map((cells) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = cells[index] ?? '';
    });
    return record;
  });
  const numeric = {};
  for (const header of headers) {
    const values = records.map((record) => record[header]).filter(isNumeric).map((value) => Number(String(value).replaceAll(',', '')));
    if (values.length === 0) continue;
    const sum = values.reduce((total, value) => total + value, 0);
    numeric[header] = {
      count: values.length,
      sum: Number(sum.toFixed(4)),
      min: Math.min(...values),
      max: Math.max(...values),
      average: Number((sum / values.length).toFixed(4)),
    };
  }
  const summary = {
    schema: 'skill-conductor/demo/csv-summary/v1',
    source: { name: path.basename(file.path), path: file.path, sha256: file.sha256, bytes: stat.size },
    rowCount: records.length,
    columnCount: headers.length,
    columns: headers,
    emptyCells: records.reduce(
      (total, record) => total + headers.filter((header) => String(record[header] ?? '').trim() === '').length,
      0,
    ),
    numeric,
    generatedAt: new Date().toISOString(),
  };
  await fs.mkdir(input.artifactDir, { recursive: true });
  await fs.writeFile(path.join(input.artifactDir, 'csv-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ rows: summary.rowCount, columns: summary.columnCount, numeric: Object.keys(numeric) })}\n`);
}

main().catch((error) => {
  process.stderr.write(`csv-inspector failed: ${error.message}\n`);
  process.exitCode = 1;
});
