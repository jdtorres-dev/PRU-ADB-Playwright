import * as fs from 'fs';
import * as path from 'path';
import { readVerdicts } from '../utils/verdict-store';
import { loadTestCases } from '../utils/registry';

/**
 * Builds a traceability report from every verdict currently on disk
 * (artifacts/e2e/verdicts/*.json, written by tests/validation).
 *
 * Safe to run at any time - it only reads what tests/validation already
 * wrote. Re-run after adding/reissuing feeds and re-validating to refresh
 * the report from the latest verdicts.
 *
 *     npm run report:build
 */

const OUT_DIR = path.join(__dirname, '..', 'artifacts', 'reports');

function csvCell(v: string): string {
  const s = (v ?? '').replace(/\r?\n/g, ' ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function main() {
  const cases = loadTestCases();
  const byId = new Map(cases.map((c) => [c.id, c]));
  const verdicts = readVerdicts();

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const header = [
    'TCID', 'BR ID', 'Type', 'Feed', 'Expected Result', 'Actual Result',
    'Destination Artifact', 'Status', 'Reason',
  ];
  const rows = verdicts.map((v) => {
    const tc = byId.get(v.testCaseId);
    const expected = v.expectedCode || v.expectedDestination || '(no code)';
    const actual = v.actualCode || '(none)';
    return [
      v.testCaseId,
      v.rule,
      tc?.type ?? '',
      v.feedFile || '(no feed)',
      expected,
      actual,
      v.actualDestination || v.expectedDestination || '',
      v.verdict,
      v.notes,
    ];
  });

  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
  fs.writeFileSync(path.join(OUT_DIR, 'traceability-report.csv'), csv);

  const counts: Record<string, number> = {};
  for (const v of verdicts) counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;

  const blockedByReason = new Map<string, number>();
  for (const v of verdicts) {
    if (v.verdict !== 'BLOCKED') continue;
    const key = v.notes.slice(0, 90);
    blockedByReason.set(key, (blockedByReason.get(key) ?? 0) + 1);
  }

  const md: string[] = [];
  md.push('# PRU ADB - traceability report');
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push('');
  md.push('## Summary');
  md.push('');
  md.push('| Status | Count |');
  md.push('|---|---:|');
  for (const status of ['PASS', 'FAIL', 'BLOCKED', 'OBSERVED']) {
    md.push(`| ${status} | ${counts[status] ?? 0} |`);
  }
  md.push(`| **Total** | **${verdicts.length}** |`);
  md.push('');
  if (blockedByReason.size) {
    md.push('## Blocked cases, by reason');
    md.push('');
    md.push('| Reason | Cases |');
    md.push('|---|---:|');
    for (const [reason, n] of [...blockedByReason.entries()].sort((a, b) => b[1] - a[1])) {
      md.push(`| ${reason}... | ${n} |`);
    }
    md.push('');
  }
  const fails = verdicts.filter((v) => v.verdict === 'FAIL');
  if (fails.length) {
    md.push('## FAIL - possible application defects');
    md.push('');
    md.push('| TCID | Rule | Expected | Actual | Notes |');
    md.push('|---|---|---|---|---|');
    for (const v of fails) {
      const expected = v.expectedCode || v.expectedDestination || '(no code)';
      md.push(`| ${v.testCaseId} | ${v.rule} | ${expected} | ${v.actualCode} | ${v.notes.slice(0, 140)} |`);
    }
    md.push('');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), md.join('\n') + '\n');

  // eslint-disable-next-line no-console
  console.log(`${verdicts.length} verdict(s) read.`);
  // eslint-disable-next-line no-console
  console.log(counts);
  // eslint-disable-next-line no-console
  console.log(`\nWritten:\n  ${path.join(OUT_DIR, 'traceability-report.csv')}\n  ${path.join(OUT_DIR, 'summary.md')}`);
}

main();
