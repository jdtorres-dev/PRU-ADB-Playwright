// Regenerates artifacts/reports/final-verdict-report-brv4.{csv,xlsx} from the
// current registry (data/test-cases.brv4.json) + every verdict JSON under
// artifacts/e2e-brv4/verdicts/. Safe to re-run any time after new TCs are
// automated/re-verified.
const fs = require('fs');
const path = require('path');
const XLSX = require(process.env.TEMP.replace(/\\/g, '/') + '/xlsxreader/node_modules/xlsx');

const registry = JSON.parse(fs.readFileSync('data/test-cases.brv4.json', 'utf8'));
const cases = Array.isArray(registry) ? registry : (registry.cases || registry.testCases || Object.values(registry)[0]);

const verdictDir = path.join('artifacts', 'e2e-brv4', 'verdicts');
const verdicts = new Map();
if (fs.existsSync(verdictDir)) {
  for (const f of fs.readdirSync(verdictDir)) {
    if (!f.endsWith('.json')) continue;
    const v = JSON.parse(fs.readFileSync(path.join(verdictDir, f), 'utf8'));
    verdicts.set(v.testCaseId, v);
  }
}

const BOILERPLATE = [
  'run completed', 'the run completed normally', 'both cycles completed',
  'day1 baseline bundle committed', 'day2 standalone', 'day3 standalone', 'day3 byte-identical',
  'completes (no b0700)', 'completes without error', 'update completed (no b0700)',
];
function isBoilerplate(desc) {
  const d = desc.toLowerCase();
  return BOILERPLATE.some((b) => d.startsWith(b) || d.includes(b));
}

function explanationFor(tc, v) {
  if (v && Array.isArray(v.checkResults) && v.checkResults.length) {
    const meaningful = v.checkResults.filter((r) => !isBoilerplate(r.description));
    const pick = meaningful.length ? meaningful : v.checkResults;
    return pick.map((r) => `${r.passed ? '[OK] ' : '[NOT AS EXPECTED] '}${r.description}`).join(' | ');
  }
  if (v && v.notes) return v.notes;
  if (tc.executable === false && tc.blockedReason) return tc.blockedReason;
  if (tc.automationNotes) return tc.automationNotes;
  return '(no explanation on file)';
}

function verdictFor(tc, v) {
  if (v) return v.verdict; // PASS or FAIL
  if (tc.executable === false) return 'BLOCKED';
  return 'BLOCKED'; // executable but never actually run - treat conservatively
}

const rows = cases.map((tc) => {
  const v = verdicts.get(tc.id);
  const verdict = verdictFor(tc, v);
  return {
    'TC ID': tc.id,
    'Rule ID': tc.rule,
    'Topic': tc.topic || '',
    'Priority': tc.priority || '',
    'Verdict': verdict,
    'Automated?': tc.executable === true ? 'Yes' : 'No',
    'Explanation (plain English)': explanationFor(tc, v),
  };
});

const summary = rows;
const pass = rows.filter((r) => r.Verdict === 'PASS');
const fail = rows.filter((r) => r.Verdict === 'FAIL');
const blocked = rows.filter((r) => r.Verdict === 'BLOCKED');

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), `Summary (All ${rows.length})`);
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pass), 'PASS');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fail), 'FAIL');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(blocked), 'BLOCKED');
fs.mkdirSync('artifacts/reports', { recursive: true });
XLSX.writeFile(wb, 'artifacts/reports/final-verdict-report-brv4.xlsx');

function csvCell(v) {
  const s = String(v ?? '').replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const header = ['TC ID', 'Rule ID', 'Topic', 'Priority', 'Verdict', 'Automated?', 'Explanation (plain English)'];
const csv = [header, ...summary.map((r) => header.map((h) => r[h]))].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
fs.writeFileSync('artifacts/reports/final-verdict-report-brv4.csv', csv);

console.log(`total=${rows.length} pass=${pass.length} fail=${fail.length} blocked=${blocked.length}`);
