// Full BRv4 evidence rerun: e2e-execute-brv4 -> e2e-validate-brv4 -> e2e-db-brv4,
// strictly in that order, one Playwright invocation per suite, each gated on
// the previous one having produced what the next one reads.
//
//   node scripts/rerun-evidence-brv4.js                       # new run
//   node scripts/rerun-evidence-brv4.js --run-dir artifacts/post-rerun-<stamp> --from e2e-db-brv4
//                                                             # resume an interrupted run
//
// Output: artifacts/post-rerun-<YYYYMMDD-HHMMSS>/
//   01-e2e-application/{e2e-execute-brv4,e2e-validate-brv4}/<TC>/   evidence
//   02-e2e-database/e2e-db-brv4/<TC>/                               evidence
//   playwright-report/          merged HTML report of the three invocations
//   evidence-index.html, evidence-summary.{json,csv}
//   _raw/                       Playwright json/blob/test-output, phase log, verdict snapshots
// Before anything runs, the current run records, verdicts, console logs and
// runtime-rewritten feeds are copied to artifacts/backup-before-post-rerun-<stamp>/.
// playwright-report-brv4/ and artifacts/results-brv4.json are not touched
// (the config routes evidence-run reporters into _raw/).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { assemble } = require('./assemble-evidence-brv4');
const { attachSql } = require('./attach-sql-to-report-brv4');

const ROOT = path.join(__dirname, '..');
const SUITES = ['e2e-execute-brv4', 'e2e-validate-brv4', 'e2e-db-brv4'];
const E2E = path.join(ROOT, 'artifacts', 'e2e-brv4');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const runDir = path.resolve(arg('--run-dir') || path.join(ROOT, 'artifacts', `post-rerun-${stamp}`));
const fromSuite = arg('--from') || SUITES[0];
if (!SUITES.includes(fromSuite)) throw new Error(`--from must be one of ${SUITES.join(', ')}`);
const raw = path.join(runDir, '_raw');
const phaseLogPath = path.join(raw, 'phase-log.json');
const readJson = (p, d = null) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d);

fs.mkdirSync(path.join(raw, 'logs'), { recursive: true });
fs.mkdirSync(path.join(runDir, '01-e2e-application'), { recursive: true });
fs.mkdirSync(path.join(runDir, '02-e2e-database'), { recursive: true });

const phaseLog = readJson(phaseLogPath, { startedAt: new Date().toISOString(), phases: SUITES.map((suite, i) => ({ order: i + 1, suite, state: 'PENDING' })) });
const savePhaseLog = () => fs.writeFileSync(phaseLogPath, JSON.stringify(phaseLog, null, 2));
savePhaseLog();

function copyDir(src, dest, filter = () => true) {
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory() || !filter(e.name)) continue;
    fs.copyFileSync(path.join(src, e.name), path.join(dest, e.name));
    n++;
  }
  return n;
}

function backup() {
  const dir = path.join(ROOT, 'artifacts', `backup-before-post-rerun-${path.basename(runDir).replace(/^post-rerun-/, '')}`);
  if (fs.existsSync(dir)) return dir;
  const counts = {
    runRecords: copyDir(path.join(E2E, 'runs'), path.join(dir, 'e2e-brv4', 'runs'), (f) => f.endsWith('.json')),
    verdicts: copyDir(path.join(E2E, 'verdicts'), path.join(dir, 'e2e-brv4', 'verdicts')),
    consoleLogs: copyDir(path.join(E2E, 'console'), path.join(dir, 'e2e-brv4', 'console')),
    feeds: copyDir(path.join(ROOT, 'data', 'feeds'), path.join(dir, 'data', 'feeds'), (f) => /^ALLSTATE\.LNA\.(VALIDATE-)?BR-/.test(f)),
    registries: copyDir(path.join(ROOT, 'data'), path.join(dir, 'data'), (f) => f.endsWith('.brv4.json')),
  };
  fs.writeFileSync(path.join(dir, 'backup-manifest.json'), JSON.stringify({ takenAt: new Date().toISOString(), forRun: path.relative(ROOT, runDir), counts }, null, 2));
  return dir;
}

function snapshot(suite) {
  const dir = path.join(raw, 'snapshots', `after-${suite}`);
  copyDir(path.join(E2E, 'verdicts'), path.join(dir, 'verdicts'));
  copyDir(path.join(E2E, 'runs'), path.join(dir, 'runs'), (f) => f.endsWith('.json'));
}

function run(cmd, args, env, logFile) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, shell: true });
    child.stdout.on('data', (d) => { process.stdout.write(d); out.write(d); });
    child.stderr.on('data', (d) => { process.stderr.write(d); out.write(d); });
    child.on('close', (code) => { out.end(); resolve(code); });
  });
}

function jsonTests(suite) {
  const report = readJson(path.join(raw, 'json', `${suite}.json`));
  if (!report) return null;
  const tests = [];
  const walk = (s) => { for (const sp of s.specs || []) for (const t of sp.tests || []) tests.push({ title: sp.title, results: t.results || [] }); (s.suites || []).forEach(walk); };
  (report.suites || []).forEach(walk);
  return tests;
}

// What the NEXT suite needs from this one. Returns '' when satisfied.
function gate(suite, startedAt) {
  const tests = jsonTests(suite);
  if (!tests) return `${suite} produced no JSON report - the Playwright invocation did not complete`;
  if (suite === 'e2e-execute-brv4') {
    const feeds = readJson(path.join(ROOT, 'data', 'feeds.brv4.json'));
    const stale = feeds.filter((f) => {
      const rec = readJson(path.join(E2E, 'runs', `${f.file.replace(/[^A-Za-z0-9._-]/g, '_')}.json`));
      return !rec || Date.parse(rec.uploadedAt) < Date.parse(startedAt);
    });
    // e2e-validate-brv4 reads these run records; a stale one would be judged
    // as if it came from this rerun.
    if (stale.length) return `no run record written by this rerun for ${stale.length}/${feeds.length} feed(s): ${stale.map((f) => f.file).join(', ')}`;
  }
  if (suite === 'e2e-validate-brv4') {
    const cases = readJson(path.join(ROOT, 'data', 'test-cases.brv4.json')).filter((c) => c.executable && c.feeds.length);
    const missing = cases.filter((c) => !tests.some((t) => t.title.startsWith(`${c.id} `) && t.results.length));
    if (missing.length) return `validation produced no result for ${missing.map((c) => c.id).join(', ')}`;
  }
  return '';
}

(async () => {
  const backupDir = backup();
  phaseLog.backupDir = path.relative(ROOT, backupDir);
  savePhaseLog();
  console.log(`\nEvidence run: ${path.relative(ROOT, runDir)}\nBackup:       ${path.relative(ROOT, backupDir)}\n`);

  let stopReason = '';
  for (const suite of SUITES.slice(SUITES.indexOf(fromSuite))) {
    const p = phaseLog.phases.find((x) => x.suite === suite);
    if (stopReason) {
      Object.assign(p, { state: 'NOT RUN', reason: `blocked: ${stopReason}` });
      savePhaseLog();
      continue;
    }
    Object.assign(p, { state: 'RUNNING', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, reason: '' });
    savePhaseLog();
    console.log(`\n=== Phase ${p.order}/3: ${suite} ===\n`);
    const code = await run('npx', ['playwright', 'test', '-c', 'playwright.brv4.config.ts', `--project=${suite}`],
      { BRV4_EVIDENCE_ROOT: runDir, BRV4_EVIDENCE_SUITE: suite }, path.join(raw, 'logs', `${suite}.log`));
    p.finishedAt = new Date().toISOString();
    p.exitCode = code;
    snapshot(suite);
    const problem = gate(suite, p.startedAt);
    p.tests = (jsonTests(suite) || []).length;
    // Exit code 1 just means some test failed - a normal outcome. Only a
    // missing prerequisite blocks the next suite.
    p.state = problem ? 'INCOMPLETE' : 'COMPLETED';
    p.reason = problem || (code === 0 ? 'all tests passed' : 'completed with failing test(s)');
    if (problem) stopReason = `${suite}: ${problem}`;
    savePhaseLog();
  }

  if (fs.existsSync(path.join(raw, 'blob', 'e2e-db-brv4', 'e2e-db-brv4.zip'))) {
    console.log('\n=== Attaching DB SQL to e2e-db-brv4 report entries ===\n');
    phaseLog.sqlAttach = attachSql(runDir);
    savePhaseLog();
  }

  console.log('\n=== Merging reports ===\n');
  const mergeDir = path.join(raw, 'blob', '_merge');
  fs.rmSync(mergeDir, { recursive: true, force: true }); // our own scratch copy only
  fs.mkdirSync(mergeDir, { recursive: true });
  for (const s of SUITES) {
    const z = path.join(raw, 'blob', s, `${s}.zip`);
    if (fs.existsSync(z)) fs.copyFileSync(z, path.join(mergeDir, `${s}.zip`));
  }
  const mergeCode = await run('npx', ['playwright', 'merge-reports', '--reporter=html', `"${mergeDir}"`],
    { PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(runDir, 'playwright-report'), PLAYWRIGHT_HTML_OPEN: 'never' }, path.join(raw, 'logs', 'merge-reports.log'));
  phaseLog.mergeExitCode = mergeCode;
  phaseLog.finishedAt = new Date().toISOString();
  savePhaseLog();

  console.log('\n=== Assembling evidence ===\n');
  const { summary, linkCheck, secretCheck } = assemble(runDir);
  console.log(JSON.stringify({ phases: phaseLog.phases.map((p) => `${p.suite}: ${p.state} (${p.reason})`), perSuite: summary.perSuite, overall: summary.overall, linkCheck: { checked: linkCheck.checked, linkPages: linkCheck.linkPages, broken: linkCheck.broken }, secretHits: secretCheck.hits.length }, null, 2));
  console.log(`\nEvidence index: ${path.relative(ROOT, path.join(runDir, 'evidence-index.html'))}`);
})();
