#!/usr/bin/env node
/**
 * First-party synthetic fixture generator for the live integration harness.
 * Optional development tooling; the zero-dependency runtime does not need it.
 *
 * Requires Python 3 with reportlab, python-docx and openpyxl.
 *   node scripts/generate-fixtures.mjs --out integration-temp/fixtures
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const home = os.homedir();
const pythonCandidates = [
  process.env.SKILL_CONDUCTOR_PYTHON,
  process.env.PYTHON,
  path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'),
  path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
].filter(Boolean);
const python = pythonCandidates.find((candidate) => existsSync(candidate))
  || (process.platform === 'win32' ? 'python' : 'python3');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const outDir = path.resolve(process.cwd(), argValue('--out', 'integration-temp/fixtures'));

const pythonSource = String.raw`
import sys
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from docx import Document
from docx.shared import Pt
import openpyxl

out = sys.argv[1]

# Two-page synthetic PDF.
c = canvas.Canvas(out + "/source.pdf", pagesize=letter)
width, height = letter
c.setFont("Helvetica", 12)
c.drawString(72, height - 96, "SYNTHETIC INTEGRATION FIXTURE")
c.drawString(72, height - 120, "pressure_kpa: 420")
c.showPage()
c.setFont("Helvetica", 12)
c.drawString(72, height - 96, "batch: BETA-17")
c.showPage()
c.save()

# DOCX with a title, specimen paragraph and a field table.
doc = Document()
doc.add_heading("Synthetic anchor test", level=0)
doc.add_paragraph("specimen: CA-7")
table = doc.add_table(rows=1, cols=2)
table.rows[0].cells[0].text = "field"
table.rows[0].cells[1].text = "value"
for key, value in [("load_kN", "630"), ("status", "HOLD")]:
    row = table.add_row()
    row.cells[0].text = key
    row.cells[1].text = value
doc.save(out + "/source.docx")

# XLSX with one deliberately wrong reported total.
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Fixture"
ws.append(["item", "quantity", "price", "reported_total"])
for row in [("A", 4, 12, 48), ("B", 3, 7, 21), ("C", 2, 9, 19)]:
    ws.append(row)
wb.save(out + "/source.xlsx")
`;

const html = `<!doctype html>
<html lang="en"><head><title>Synthetic fixture</title>
<style>*{outline:none}button{transition:all 1s}</style></head>
<body><h1>Fixture</h1>
<img src="hero.png">
<input type="text" placeholder="Your name">
<div onclick="alert('go')">Continue</div>
<a href="#">click here</a>
<button onclick="alert('save')">Save</button>
</body></html>
`;

const sum = 'export function sumValues(values){let total=0;for(let i=0;i<values.length-1;i++)total+=values[i];return total;}\n';
const sumTest = `import test from 'node:test';import assert from 'node:assert/strict';import{sumValues}from'./sum.mjs';
test('sums every item',()=>assert.equal(sumValues([1,2,3]),6));
test('empty sum',()=>assert.equal(sumValues([]),0));
test('singleton sum',()=>assert.equal(sumValues([5]),5));
`;

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const script = path.join(outDir, '.generate-fixtures.py');
  await fs.writeFile(script, pythonSource, 'utf8');
  const result = await new Promise((resolve) => {
    const child = spawn(python, [script, outDir], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code, stderr }));
  });
  await fs.rm(script, { force: true });
  if (result.code !== 0) throw new Error(`fixture generation failed: ${result.stderr}`);
  await fs.writeFile(path.join(outDir, 'fixture.html'), html, 'utf8');
  await fs.writeFile(path.join(outDir, 'sum.mjs'), sum, 'utf8');
  await fs.writeFile(path.join(outDir, 'sum.test.mjs'), sumTest, 'utf8');
  const truth = {
    synthetic: true,
    pdf: { pages: 2, pressure_kpa: 420, batch: 'BETA-17' },
    docx: { title: 'Synthetic anchor test', specimen: 'CA-7', load_kN: 630, status: 'HOLD' },
    xlsx: {
      subsetHeaders: ['item', 'quantity'],
      subsetRows: [['A', 4], ['B', 3], ['C', 2]],
      correctAmountTotal: 87,
      wrongAmountRow: 4,
    },
    html: { requiredCategories: ['image-alt', 'input-label', 'focus-or-keyboard'], minimumKnownIssues: 3 },
    debug: { sum: [6, 0, 5] },
    tdd: { function: 'parsePercent', cases: [['12.5%', 0.125], ['0%', 0.0], ['100%', 1.0]], invalid: ['', 'abc', '12'] },
  };
  await fs.writeFile(path.join(outDir, 'fixture-truth.generated.json'), `${JSON.stringify(truth, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ outDir, files: ['source.pdf', 'source.docx', 'source.xlsx', 'fixture.html', 'sum.mjs', 'sum.test.mjs', 'fixture-truth.generated.json'] }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
