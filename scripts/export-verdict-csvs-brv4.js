// Splits the BRv4 verdicts (artifacts/e2e-brv4/verdicts/*.json) into one CSV
// per verdict - PASS, FAIL, BLOCKED - under artifacts/reports/.
// Usage: node scripts/export-verdict-csvs-brv4.js [YYYYMMDD]
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const verdictDir = path.join(root, 'artifacts', 'e2e-brv4', 'verdicts');
const outDir = path.join(root, 'artifacts', 'reports');
const stamp = process.argv[2] || new Date().toISOString().slice(0, 10).replace(/-/g, '');

const cols = [
  ['TC ID', (v) => v.testCaseId],
  ['Rule ID', (v) => v.rule],
  ['Topic', (v) => v.topic],
  ['Priority', (v) => v.priority],
  ['Verdict', (v) => v.verdict],
  ['Verification Route', (v) => v.verificationRoute],
  ['Feed File', (v) => v.feedFile],
  ['Run ID', (v) => v.runId],
  ['Run Status', (v) => v.runStatus],
  ['Actual Summary', (v) => v.actualSummary],
  ['Checks Passed', (v) => (v.checkResults || []).filter((c) => c.passed).length],
  ['Checks Total', (v) => (v.checkResults || []).length],
  ['Failed Checks', (v) => (v.checkResults || []).filter((c) => !c.passed).map((c) => c.description).join(' | ')],
  ['Notes / Reason', (v) => v.notes],
  ['Decided At', (v) => v.decidedAt],
];

const esc = (x) => {
  const s = x == null ? '' : String(x).replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const tcNum = (id) => Number((id.match(/\d+/) || [0])[0]);
const verdicts = fs.readdirSync(verdictDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(verdictDir, f), 'utf8')))
  .sort((a, b) => tcNum(a.testCaseId) - tcNum(b.testCaseId) || a.testCaseId.localeCompare(b.testCaseId));

fs.mkdirSync(outDir, { recursive: true });
for (const [verdict, name] of [['PASS', 'pass'], ['FAIL', 'fail'], ['BLOCKED', 'blocked']]) {
  const rows = verdicts.filter((v) => v.verdict === verdict);
  const file = path.join(outDir, `brv4-${name}-tcs-${stamp}.csv`);
  const lines = [cols.map(([h]) => h).join(','), ...rows.map((v) => cols.map(([, f]) => esc(f(v))).join(','))];
  fs.writeFileSync(file, '﻿' + lines.join('\r\n') + '\r\n');
  console.log(`${verdict.padEnd(8)} ${String(rows.length).padStart(4)}  ${path.relative(root, file)}`);
}
const other = verdicts.filter((v) => !['PASS', 'FAIL', 'BLOCKED'].includes(v.verdict));
if (other.length) console.log(`(not exported, other verdicts: ${other.map((v) => `${v.testCaseId}=${v.verdict}`).join(', ')})`);
