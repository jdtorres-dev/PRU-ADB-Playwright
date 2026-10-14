// Shows the old and new data for a BRv4 DB-verified test case - READ ONLY.
//
//   npx tsx scripts/show-db-change-brv4.ts TC-BR-392
//   npx tsx scripts/show-db-change-brv4.ts TC-BR-392 --bd A995000000
//   npx tsx scripts/show-db-change-brv4.ts TC-BR-405 --ssn 995050001
//
// 1. OLD vs NEW as the test captured them: the "before=... after=..." values
//    the case wrote into its verdict (artifacts/e2e-brv4/verdicts/<TC>.json).
//    The master tables keep only the current value, so this is the only record
//    of the old value.
// 2. The row as it is in the database NOW (adsi_master.organization_record for
//    a firm, adsi_master.contract_record for a producer).
// 3. Firm only: the activity_log_entry rows (the "change marks") for the firm's
//    org code.
//
// Every query runs inside BEGIN TRANSACTION READ ONLY ... ROLLBACK, so this
// script cannot change the database. Connection details come from .env and
// are never printed.
import * as fs from 'fs';
import * as path from 'path';
import { types } from 'pg';
import { withDb } from '../utils/db.brv4';

// Show DATE / TIMESTAMP columns exactly as stored. They carry no time zone, and
// letting pg turn them into JS Dates shifts them by the machine's UTC offset.
types.setTypeParser(1082, (s: string) => s);
types.setTypeParser(1114, (s: string) => s);

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const tcId = (args.find((a) => /^TC-BR-\d+$/i.test(a)) || '').toUpperCase();
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!tcId) {
  console.error('usage: npx tsx scripts/show-db-change-brv4.ts TC-BR-<n> [--bd A99xxxxx00] [--ssn 99xxxxxxx]');
  process.exit(2);
}

type Row = Record<string, unknown>;
const show = (v: unknown) => (v === null || v === undefined ? '(null)' : v instanceof Date ? v.toISOString() : String(v));
const line = (n = 78) => console.log('-'.repeat(n));
function printTable(headers: string[], rows: string[][]) {
  const w = headers.map((h, i) => Math.min(60, Math.max(h.length, ...rows.map((r) => (r[i] || '').length))));
  const fmt = (r: string[]) => r.map((c, i) => (c || '').slice(0, w[i]).padEnd(w[i])).join(' | ');
  console.log(fmt(headers));
  console.log(w.map((n) => '-'.repeat(n)).join('-+-'));
  for (const r of rows) console.log(fmt(r));
}

// ---- 1. what the test captured
function readVerdict(): any {
  const p = path.join(ROOT, 'artifacts', 'e2e-brv4', 'verdicts', `${tcId}.json`);
  if (fs.existsSync(p)) return { ...JSON.parse(fs.readFileSync(p, 'utf8')), _file: path.relative(ROOT, p) };
  return null;
}
function parseBeforeAfter(detail: string): { before: Row | null; after: Row | null } | null {
  const b = detail.indexOf('before=');
  const a = detail.indexOf(' after=');
  if (b < 0 || a < 0) return null;
  try {
    return { before: JSON.parse(detail.slice(b + 7, a)), after: JSON.parse(detail.slice(a + 7).trim()) };
  } catch {
    return null;
  }
}

async function main() {
  const v = readVerdict();
  console.log(`\n${tcId}  -  old vs new data (read only)`);
  line();
  let captured: { before: Row | null; after: Row | null } | null = null;
  if (!v) {
    console.log(`No verdict file for ${tcId} in artifacts/e2e-brv4/verdicts/ - run the test first:`);
    console.log(`  npx playwright test -c playwright.brv4.config.ts --project=e2e-db-brv4 -g "${tcId}"`);
  } else {
    console.log(`Verdict: ${v.verdict}   decided: ${v.decidedAt}   (${v._file})`);
    for (const c of v.checkResults || []) {
      const ba = parseBeforeAfter(c.detail || '');
      if (!ba) continue;
      captured = captured || ba;
      console.log(`\n1) OLD vs NEW captured by the test  [${c.passed ? 'PASS' : 'FAIL'}] ${c.description}`);
      const cols = [...new Set([...Object.keys(ba.before || {}), ...Object.keys(ba.after || {})])];
      printTable(['column', 'OLD (before day 2)', 'NEW (after day 2)', 'changed?'],
        cols.map((k) => {
          const o = show(ba.before?.[k]); const n = show(ba.after?.[k]);
          return [k, o, n, o === n ? 'no' : 'YES'];
        }));
    }
    if (!captured) console.log('\n1) This case did not record before/after values in its verdict.');
  }

  // ---- identity for the live lookup
  let bd = opt('--bd');
  const ssn = opt('--ssn');
  if (!bd && !ssn && captured) {
    const name = String(captured.before?.org_full_name ?? '');
    const m = name.match(/BD(\d{5})/); // test firms are named "E2E BRV4 BD<seq> LLC"; BD id = A99<seq>00
    if (m) bd = `A99${m[1]}00`;
  }
  if (!bd && !ssn) {
    console.log('\n2) Live lookup skipped - pass --bd <BD id> (firm) or --ssn <SSN> (producer).');
    return;
  }

  // what the test saw after day 2, to compare with the live row
  const capturedAfter: Row | null = captured ? (captured as { after: Row | null }).after : null;

  await withDb(async (client) => {
    await client.query('BEGIN TRANSACTION READ ONLY');
    try {
      if (bd) {
        const org = await client.query(
          `SELECT o.org_code FROM pru_adb.contract c
             JOIN pru_adb.node_relationship nr ON nr.child_node_id = c.node_id AND nr.relationship_type = 'ORG_TO_BD'
             JOIN pru_adb.organization o ON o.node_id = nr.parent_node_id
            WHERE c.allstate_id = $1`, [bd]);
        const orgCode: string | undefined = org.rows[0]?.org_code;
        console.log(`\n2) NOW in the database - firm BD ${bd}, org code ${orgCode ?? '(not found)'}`);
        if (orgCode) {
          const rec = await client.query('SELECT * FROM adsi_master.organization_record WHERE contract_number = $1', [orgCode]);
          if (!rec.rows.length) console.log('   no adsi_master.organization_record row');
          for (const r of rec.rows as Row[]) {
            printTable(['adsi_master.organization_record', 'value now', 'note'],
              Object.entries(r).map(([k, val]) => {
                const nowV = show(val);
                let note = '';
                if (capturedAfter && k in capturedAfter) note = nowV === show(capturedAfter[k]) ? 'matches NEW' : 'differs from NEW';
                return [k, nowV, note];
              }));
          }
          const act = await client.query(
            `SELECT activity_ts, transaction_code, purpose_code, subject_id, processed_ts, crt_by_id
               FROM pru_adb.activity_log_entry WHERE pru_contract_or_org_code = $1 ORDER BY activity_ts`, [orgCode]);
          console.log(`\n3) Change marks - pru_adb.activity_log_entry for org code ${orgCode}: ${act.rows.length} row(s)`);
          if (act.rows.length) {
            printTable(['activity_ts', 'transaction', 'purpose', 'subject_id', 'processed_ts', 'created_by'],
              (act.rows as Row[]).map((r) => [show(r.activity_ts), show(r.transaction_code), show(r.purpose_code), show(r.subject_id), show(r.processed_ts), show(r.crt_by_id)]));
          }
        }
      }
      if (ssn) {
        const rec = await client.query('SELECT * FROM adsi_master.contract_record WHERE alternate_key_ssn_or_tin = $1', [ssn]);
        console.log(`\n2) NOW in the database - producer SSN ${ssn}: ${rec.rows.length} adsi_master.contract_record row(s)`);
        for (const r of rec.rows as Row[]) {
          printTable(['adsi_master.contract_record', 'value now', 'note'],
            Object.entries(r).map(([k, val]) => {
              const nowV = show(val);
              let note = '';
              if (capturedAfter && k in capturedAfter) note = nowV === show(capturedAfter[k]) ? 'matches NEW' : 'differs from NEW';
              return [k, nowV, note];
            }));
        }
      }
    } finally {
      await client.query('ROLLBACK');
    }
  });
  console.log('');
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
