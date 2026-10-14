// Adds each e2e-db-brv4 case's SQL (query-reference.sql) to that test's
// entry in the run's Playwright report - shown inline, under Attachments -
// without re-running the suite. Works on the saved blob report:
//
//   node scripts/attach-sql-to-report-brv4.js artifacts/post-rerun-<stamp> [--merge]
//
// The SQL is extracted from utils/db-verified-cases.brv4.ts (the statements the
// case's code path runs), with $1/$2 placeholders - the bound values of the
// run are not in it. Idempotent: a test that already has the attachment is
// skipped. The blob is backed up once to _raw/blob-before-sql/ first.
// --merge rebuilds <run>/playwright-report from the patched blobs afterwards.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const { sqlReferenceForTc, writeSqlReference } = require('./assemble-evidence-brv4');

const ROOT = path.join(__dirname, '..');
const SUITE = 'e2e-db-brv4';
const NAME = 'SQL run against the DB (query-reference.sql)';

function attachSql(runDirArg) {
  const runDir = path.resolve(runDirArg);
  const blob = path.join(runDir, '_raw', 'blob', SUITE, `${SUITE}.zip`);
  if (!fs.existsSync(blob)) throw new Error(`no blob report at ${blob}`);
  const backup = path.join(runDir, '_raw', 'blob-before-sql', `${SUITE}.zip`);
  if (!fs.existsSync(backup)) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(blob, backup); }

  const zip = new AdmZip(blob);
  const events = zip.getEntry('report.jsonl').getData().toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

  // testId/resultId per TC, from the verdict attachment utils/evidence.brv4.ts added.
  const targets = new Map();
  const done = new Set();
  for (const e of events) {
    if (e.method !== 'onAttach') continue;
    for (const a of e.params.attachments) {
      const m = a.name.match(/^(TC-BR-\d+): db-verification-result\.json$/);
      if (m) targets.set(`${e.params.testId}|${e.params.resultId}`, m[1]);
      if (a.name === NAME) done.add(`${e.params.testId}|${e.params.resultId}`);
    }
  }

  const out = [];
  let added = 0;
  const missing = [];
  for (const e of events) {
    out.push(e);
    if (e.method !== 'onAttach') continue;
    const key = `${e.params.testId}|${e.params.resultId}`;
    const tcId = targets.get(key);
    if (!tcId || done.has(key) || !e.params.attachments.some((a) => a.name === `${tcId}: db-verification-result.json`)) continue;
    const tcDir = path.join(runDir, '02-e2e-database', SUITE, tcId);
    const ref = sqlReferenceForTc(tcId);
    if (!ref) { missing.push(tcId); continue; }
    writeSqlReference(tcDir, tcId, ref); // same file the evidence folder holds
    // Steps refer to a result's attachments by index (onStepEnd step.attachments),
    // so inserting must not shift any index a step uses. The verdict JSON is the
    // last attachment utils/evidence.brv4.ts attaches inside a step; only
    // step-less ones (video, screenshot) follow it, so inserting here is safe.
    const sql = fs.readFileSync(path.join(tcDir, 'query-reference.sql'));
    out.push({ method: 'onAttach', params: { testId: e.params.testId, resultId: e.params.resultId, attachments: [{ name: NAME, contentType: 'text/plain', base64: sql.toString('base64') }] } });
    done.add(key);
    added++;
  }

  zip.updateFile('report.jsonl', Buffer.from(out.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'));
  zip.writeZip(blob);
  return { tests: targets.size, added, alreadyPresent: targets.size - added - missing.length, missing };
}

function mergeReport(runDirArg) {
  const runDir = path.resolve(runDirArg);
  const raw = path.join(runDir, '_raw');
  const mergeDir = path.join(raw, 'blob', '_merge');
  fs.rmSync(mergeDir, { recursive: true, force: true }); // our own scratch copy only
  fs.mkdirSync(mergeDir, { recursive: true });
  for (const s of ['e2e-execute-brv4', 'e2e-validate-brv4', 'e2e-db-brv4']) {
    const z = path.join(raw, 'blob', s, `${s}.zip`);
    if (fs.existsSync(z)) fs.copyFileSync(z, path.join(mergeDir, `${s}.zip`));
  }
  const r = spawnSync('npx', ['playwright', 'merge-reports', '--reporter=html', `"${mergeDir}"`], {
    cwd: ROOT, shell: true, stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(runDir, 'playwright-report'), PLAYWRIGHT_HTML_OPEN: 'never' },
  });
  return r.status;
}

module.exports = { attachSql, mergeReport };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/attach-sql-to-report-brv4.js artifacts/post-rerun-<stamp> [--merge]'); process.exit(2); }
  console.log(JSON.stringify(attachSql(dir)));
  if (process.argv.includes('--merge')) process.exit(mergeReport(dir));
}
