// Assembles the per-TC evidence folders of one BRv4 evidence run
// (artifacts/post-rerun-<stamp>/, created by scripts/rerun-evidence-brv4.js).
//
//   node scripts/assemble-evidence-brv4.js artifacts/post-rerun-<stamp>
//
// Runs after all three suites finished, so every recording/screenshot is
// already fully written by Playwright. utils/evidence.brv4.ts captured the
// in-test evidence (exact feed bytes, downloaded ZIPs, the verdict as each
// suite wrote it); this adds recordings, screenshots, traces, stdout, SQL
// references and an evidence-manifest.json per TC per suite, then writes
// evidence-index.html / evidence-summary.{json,csv} and checks every link.
// Re-runnable: it only adds/overwrites files it generates itself.
// Never decides a verdict - statuses come from the Playwright results and the
// verdict files the suites themselves wrote.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const ROOT = path.join(__dirname, '..');
const SUITES = ['e2e-execute-brv4', 'e2e-validate-brv4', 'e2e-db-brv4'];
const SUITE_DIR = {
  'e2e-execute-brv4': '01-e2e-application/e2e-execute-brv4',
  'e2e-validate-brv4': '01-e2e-application/e2e-validate-brv4',
  'e2e-db-brv4': '02-e2e-database/e2e-db-brv4',
};

const posix = (p) => p.split(path.sep).join('/');
const readJson = (p, dflt = null) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : dflt);
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); };
const stripAnsi = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');
const safeName = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function pwStatus(s) {
  if (s === 'passed') return 'PASS';
  if (s === 'failed' || s === 'timedOut' || s === 'interrupted') return 'FAIL';
  if (s === 'skipped') return 'SKIPPED';
  return 'NOT RUN';
}

// ---------------------------------------------------------------- inputs

function loadPlaywrightResults(runDir, suite) {
  const report = readJson(path.join(runDir, '_raw', 'json', `${suite}.json`));
  const tests = [];
  if (!report) return { report: null, tests };
  const walk = (s, titles) => {
    for (const spec of s.specs || []) {
      for (const t of spec.tests || []) {
        tests.push({ id: spec.id, title: spec.title, file: spec.file, project: t.projectName, annotations: t.annotations || [], results: t.results || [] });
      }
    }
    for (const c of s.suites || []) walk(c, [...titles, c.title]);
  };
  for (const s of report.suites || []) walk(s, [s.title]);
  return { report, tests };
}

function dbCaseIds() {
  const src = fs.readFileSync(path.join(ROOT, 'utils', 'db-verified-cases.brv4.ts'), 'utf8');
  return new Set([...src.matchAll(/tcId: '([^']+)'/g)].map((m) => m[1]));
}

// ------------------------------------------------- SQL reference extraction

const DB_SRC_REL = 'utils/db-verified-cases.brv4.ts';
let dbSrcLines = null;
let topFunctions = null;
function dbSource() {
  if (!dbSrcLines) {
    dbSrcLines = fs.readFileSync(path.join(ROOT, DB_SRC_REL), 'utf8').replace(/\r\n/g, '\n').split('\n');
    topFunctions = new Map();
    dbSrcLines.forEach((l, i) => {
      const m = l.match(/^(?:export )?(?:async )?function (\w+)\s*[(<]/);
      if (m) {
        let end = i + 1;
        while (end < dbSrcLines.length && !/^\}/.test(dbSrcLines[end])) end++;
        topFunctions.set(m[1], { start: i, end });
      }
    });
  }
  return dbSrcLines;
}

function blockForTc(tcId) {
  const lines = dbSource();
  const idx = lines.findIndex((l) => l.includes(`tcId: '${tcId}'`));
  if (idx < 0) return null;
  let start = idx;
  while (start > 0 && !/^[A-Za-z_]/.test(lines[start])) start--;
  let end = idx;
  while (end < lines.length - 1 && !/^[})\]]/.test(lines[end])) end++;
  return { start, end };
}

const SQL_RE = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;
function sqlLiterals(text) {
  const out = [];
  for (const m of text.matchAll(/`[^`]*`|'(?:[^'\\\n]|\\.)*'/g)) {
    const body = m[0].slice(1, -1);
    if (SQL_RE.test(body) && /\b(FROM|INTO|SET|pru_adb|adsi_master)\b/i.test(body)) out.push(body.replace(/\s+/g, ' ').trim());
  }
  return out;
}

function sqlReferenceForTc(tcId) {
  const lines = dbSource();
  const block = blockForTc(tcId);
  if (!block) return null;
  const parts = [{ name: `case ${tcId}`, start: block.start, end: block.end }];
  const seen = new Set();
  const queue = [{ text: lines.slice(block.start, block.end + 1).join('\n'), depth: 0 }];
  while (queue.length) {
    const { text, depth } = queue.shift();
    if (depth >= 3) continue;
    for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      const fn = topFunctions.get(m[1]);
      if (!fn || seen.has(m[1])) continue;
      seen.add(m[1]);
      const body = lines.slice(fn.start, fn.end + 1).join('\n');
      parts.push({ name: m[1], start: fn.start, end: fn.end });
      queue.push({ text: body, depth: depth + 1 });
    }
  }
  const statements = [];
  for (const p of parts) {
    for (const sql of sqlLiterals(lines.slice(p.start, p.end + 1).join('\n'))) {
      const kind = /^\s*SELECT\b/i.test(sql) ? 'READ' : 'WRITE';
      if (!statements.some((s) => s.sql === sql)) statements.push({ kind, from: p.name, lines: `${p.start + 1}-${p.end + 1}`, sql });
    }
  }
  const blockText = lines.slice(block.start, block.end + 1).join('\n');
  const columnsOpt = [...blockText.matchAll(/columns:\s*'([^']*)'/g)].map((m) => m[1]);
  const all = statements.map((s) => s.sql).join('\n');
  const tables = [...new Set([...all.matchAll(/\b((?:pru_adb|adsi_master)\.[a-z_]+)/g)].map((m) => m[1]))].sort();
  const columns = new Set(columnsOpt.flatMap((c) => c.split(',').map((x) => x.trim())).filter((c) => c && c !== '*'));
  for (const s of statements) {
    for (const m of s.sql.matchAll(/\b(?:[a-z]+\.)?([a-z_][a-z0-9_]*)(?:\s*(?:=|<>|!=|~|>=|<=)|\s+(?:IS|BETWEEN|IN)\b)/gi)) columns.add(m[1]);
    const ins = s.sql.match(/INSERT\s+INTO\s+\S+\s*\(([^)]*)\)/i);
    if (ins) ins[1].split(',').forEach((c) => columns.add(c.trim()));
    const sel = s.sql.match(/^SELECT\s+(.*?)\s+FROM\b/i);
    if (sel && !sel[1].includes('${')) sel[1].split(',').forEach((c) => { const n = c.trim().split(/\s+AS\s+|\s+/i).pop(); if (/^[a-z_][\w.]*$/i.test(n)) columns.add(n.replace(/^\w+\./, '')); });
  }
  const sqlKeywords = new Set(['select', 'from', 'where', 'and', 'or', 'not', 'null', 'is', 'as', 'on', 'join', 'max', 'seq', 'r', 's']);
  return {
    source: DB_SRC_REL,
    caseLines: `${block.start + 1}-${block.end + 1}`,
    helpers: parts.slice(1).map((p) => ({ name: p.name, lines: `${p.start + 1}-${p.end + 1}` })),
    statements,
    columnsOption: columnsOpt,
    tables,
    columns: [...columns].filter((c) => !sqlKeywords.has(c.toLowerCase())).sort(),
    blockText,
  };
}

function writeSqlReference(dir, tcId, ref) {
  const out = [
    `-- ${tcId}: SQL used by e2e-db-brv4 for this case, extracted from ${ref.source}`,
    `-- Case definition: lines ${ref.caseLines}` + (ref.helpers.length ? `; helpers: ${ref.helpers.map((h) => `${h.name} (${h.lines})`).join(', ')}` : ''),
    '-- [READ]  = verification query.  [WRITE] = precondition seeding / cleanup the suite performs',
    '--           (e2e-db-brv4 is not read-only - see the run notes). Run by the suite, not by this file.',
    `-- Tables referenced: ${ref.tables.join(', ') || '(none found)'}`,
    `-- Columns referenced (auto-extracted): ${ref.columns.join(', ') || '(none found)'}`,
    ...(ref.columnsOption.length ? [`-- \${opts.columns} / \${columns} placeholders are filled from: ${ref.columnsOption.map((c) => `'${c}'`).join(', ')}`] : []),
    '-- $1, $2 ... are bound at run time to this run\'s generated identities (see db-verification-result.json).',
    '',
    ...ref.statements.map((s) => `-- [${s.kind}] ${s.from} (lines ${s.lines})\n${s.sql};\n`),
    '-- Spec-level statements run around EVERY e2e-db-brv4 case (tests/e2e-brv4/db-verified-cases.brv4.spec.ts):',
    '-- [READ]  snapshotUnprocessedActivity / reserveSeqRange; [WRITE] releaseFailedHr2Leftovers deletes only',
    '--         unprocessed activity_log_entry rows this case itself added on a date whose HR2 failed.',
  ];
  fs.writeFileSync(path.join(dir, 'query-reference.sql'), out.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'case-source.ts.txt'), `// ${ref.source} lines ${ref.caseLines}\n${ref.blockText}\n`);
}

// --------------------------------------------------------- file helpers

function isWebm(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    return b.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  } catch { return false; }
}

function copyInto(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return dest;
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function readCaptures(tcDir) {
  const logs = path.join(tcDir, 'logs');
  if (!fs.existsSync(logs)) return [];
  return fs.readdirSync(logs).filter((f) => /^capture-.*\.json$/.test(f)).map((f) => ({ file: `logs/${f}`, ...readJson(path.join(logs, f)) }));
}

// ------------------------------------------------------- per-attempt media

// Copies recordings/screenshots/traces/stdout of one Playwright test result
// into tcDir. `tag` disambiguates when one TC has several tests (setup+test
// feeds); attempt > 0 is suffixed so a retry never replaces an attempt.
function copyAttemptMedia(tcDir, tag, result) {
  const suffix = `${tag ? `-${tag}` : ''}${result.retry > 0 ? `-attempt-${result.retry}` : ''}`;
  const media = { attempt: result.retry, status: pwStatus(result.status), playwrightStatus: result.status, startTime: result.startTime, durationMs: result.duration, recordings: [], screenshots: [], traces: [], logs: [], missing: [] };
  let v = 0, s = 0;
  for (const a of result.attachments || []) {
    if (!a.path) continue;
    if (a.name === 'video' || (a.contentType || '').startsWith('video/')) {
      v++;
      const dest = path.join(tcDir, `recording${suffix}${v > 1 ? `-${v}` : ''}.webm`);
      if (fs.existsSync(a.path) && fs.statSync(a.path).size > 0) {
        copyInto(a.path, dest);
        const ok = isWebm(dest);
        media.recordings.push({ path: posix(path.relative(tcDir, dest)), status: ok ? 'VERIFIED' : 'UNREADABLE', bytes: fs.statSync(dest).size, sourcePath: posix(path.relative(ROOT, a.path)) });
      } else media.missing.push(`recording listed by Playwright but not on disk: ${posix(path.relative(ROOT, a.path))}`);
    } else if (a.name === 'screenshot' || (a.contentType || '').startsWith('image/')) {
      s++;
      const dest = path.join(tcDir, 'screenshots', `screenshot${suffix}${s > 1 ? `-${s}` : ''}${path.extname(a.path) || '.png'}`);
      if (fs.existsSync(a.path)) { copyInto(a.path, dest); media.screenshots.push(posix(path.relative(tcDir, dest))); }
    } else if (a.name === 'trace') {
      const dest = path.join(tcDir, 'logs', `trace${suffix}.zip`);
      if (fs.existsSync(a.path)) { copyInto(a.path, dest); media.traces.push(posix(path.relative(tcDir, dest))); }
    }
  }
  const out = [
    ...(result.stdout || []).map((x) => x.text ?? ''),
    ...(result.stderr || []).length ? ['--- stderr ---', ...(result.stderr || []).map((x) => x.text ?? '')] : [],
    ...(result.errors || []).length ? ['--- errors ---', ...(result.errors || []).map((e) => stripAnsi(e.message || e.value || ''))] : [],
  ].join('');
  const logPath = path.join(tcDir, 'logs', `playwright-output${suffix}.txt`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, out || '(no stdout/stderr/errors)\n');
  media.logs.push(posix(path.relative(tcDir, logPath)));
  return media;
}

// ------------------------------------------------------------------ main

function assemble(runDirArg) {
  const runDir = path.resolve(runDirArg);
  const rel = (p) => posix(path.relative(runDir, p));
  const phaseLog = readJson(path.join(runDir, '_raw', 'phase-log.json'), { phases: [] });
  const runStartedAt = Date.parse(phaseLog.startedAt || 0);
  const cases = readJson(path.join(ROOT, 'data', 'test-cases.brv4.json'));
  const feeds = readJson(path.join(ROOT, 'data', 'feeds.brv4.json'));
  const dbIds = dbCaseIds();
  const isFeedDriven = (tc) => tc.executable && tc.feeds.length > 0;
  const results = Object.fromEntries(SUITES.map((s) => [s, loadPlaywrightResults(runDir, s)]));
  const phase = (s) => phaseLog.phases.find((p) => p.suite === s) || null;
  const snapshot = (after, tcId) => readJson(path.join(runDir, '_raw', 'snapshots', `after-${after}`, 'verdicts', `${tcId}.json`));
  const isFresh = (v) => !!v && Date.parse(v.decidedAt) >= runStartedAt;

  const testsForTc = {
    'e2e-execute-brv4': (tc) => results['e2e-execute-brv4'].tests.filter((t) => {
      const feed = t.annotations.find((a) => a.type === 'feed')?.description || (t.title.match(/upload (\S+)/) || [])[1];
      return (feeds.find((f) => f.file === feed)?.cases || []).includes(tc.id);
    }),
    'e2e-validate-brv4': (tc) => results['e2e-validate-brv4'].tests.filter((t) => t.title.split(/\s+/)[0] === tc.id),
    'e2e-db-brv4': (tc) => results['e2e-db-brv4'].tests.filter((t) => t.title.split(/\s+/)[0] === tc.id),
  };

  const rows = [];
  for (const tc of cases) {
    const row = { tcId: tc.id, rule: tc.rule, topic: tc.topic, suites: {} };
    const executeFeeds = feeds.filter((f) => f.cases.includes(tc.id));

    for (const suite of SUITES) {
      const tcDir = path.join(runDir, SUITE_DIR[suite], tc.id);
      // The evidence folders only hold the TCs each part actually decides:
      // 01-e2e-application the feed-driven TCs e2e-validate-brv4 judges (and
      // their uploads), 02-e2e-database the e2e-db-brv4 cases. Every other
      // folder (NOT APPLICABLE manifests, and the uploads of DB-owned TCs) is
      // kept under _raw/excluded-tc-folders/ - moved back here while its
      // manifest is rebuilt, so a re-run never loses its captures.
      const included = suite === 'e2e-db-brv4' ? dbIds.has(tc.id) : isFeedDriven(tc);
      const excludedDir = path.join(runDir, '_raw', 'excluded-tc-folders', SUITE_DIR[suite], tc.id);
      if (!fs.existsSync(tcDir) && fs.existsSync(excludedDir)) fs.renameSync(excludedDir, tcDir);
      fs.mkdirSync(tcDir, { recursive: true });
      const tests = testsForTc[suite](tc);
      const ph = phase(suite);
      const captures = readCaptures(tcDir);
      const m = {
        tcId: tc.id, businessRuleId: tc.rule, topic: tc.topic, suite,
        applicable: false, status: 'NOT APPLICABLE', statusSource: '', verdict: null,
        executionIds: [], attempts: [], recordings: [], testData: [], generatedFiles: [],
        validationResult: null, dbVerificationResult: null, queryReference: null, dbReferences: null,
        expectedVsActual: [], screenshots: [], logs: [], sharedRelationships: [], linkedUpstream: [],
        evidenceStatus: 'NOT APPLICABLE', missing: [], notes: [],
      };

      // ---- applicability, confirmed from the suites' own scope rules
      if (suite === 'e2e-execute-brv4') {
        m.applicable = executeFeeds.length > 0;
        if (!m.applicable) m.notes.push('No feed in data/feeds.brv4.json lists this TC, so e2e-execute-brv4 uploads nothing for it.');
      } else if (suite === 'e2e-validate-brv4') {
        m.applicable = isFeedDriven(tc);
        if (!m.applicable) {
          m.notes.push(
            dbIds.has(tc.id)
              ? 'Excluded from e2e-validate-brv4 by its isFeedDriven filter (no tc.feeds) - this TC\'s verdict is decided by e2e-db-brv4.'
              : tc.executable
                ? 'Excluded from e2e-validate-brv4 by its isFeedDriven filter (executable, but no feed and no DB-verified case exists).'
                : `Not executable: ${tc.blockedReason}`,
          );
        }
      } else {
        m.applicable = dbIds.has(tc.id);
        if (!m.applicable) m.notes.push(`Not a case in ${DB_SRC_REL} (CASES), so e2e-db-brv4 does not cover it.`);
      }

      // ---- Playwright attempts + media
      tests.forEach((t) => {
        const feed = t.annotations.find((a) => a.type === 'feed')?.description || '';
        const tag = tests.length > 1 ? safeName(feed.replace(/^ALLSTATE\.LNA\.|\.D\d{8}\.txt$/g, '')) : '';
        for (const r of t.results) {
          const media = copyAttemptMedia(tcDir, tag, r);
          const runId = (t.annotations.find((a) => a.type === 'runId') || {}).description || '';
          m.attempts.push({ test: t.title, feed: feed || null, runId: runId || null, ...media });
          m.recordings.push(...media.recordings.map((x) => ({ ...x, attempt: r.retry, test: t.title })));
          m.screenshots.push(...media.screenshots);
          m.logs.push(...media.logs, ...media.traces);
          m.missing.push(...media.missing);
        }
      });

      // ---- in-test captures (utils/evidence.brv4.ts)
      for (const c of captures) {
        m.logs.push(c.file);
        for (const u of c.uploads || []) {
          const copied = (c.copied?.testData || []).find((p) => path.basename(p) === u.feedFile || path.basename(p).startsWith(u.feedFile.replace(/\.txt$/, '')));
          m.testData.push({ path: copied || null, feedFile: u.feedFile, sourcePath: u.sourcePath, feedDate: u.feedDate, runId: u.runId, chosenAt: u.chosenAt, sharedWith: c.sharedWith || [] });
          if (u.runId) m.executionIds.push(u.runId);
          if (!copied) m.missing.push(`feed ${u.feedFile} was uploaded but no copy was captured`);
        }
        for (const g of c.copied?.generatedFiles || []) m.generatedFiles.push({ path: g, status: fs.existsSync(path.join(tcDir, g)) ? 'PRESENT' : 'MISSING' });
        for (const d of c.downloads || []) if (d.runId) m.executionIds.push(d.runId);
        for (const l of c.copied?.logs || []) m.logs.push(l);
        for (const e of c.captureErrors || []) m.missing.push(e);
        if ((c.sharedWith || []).length) m.sharedRelationships.push(`${c.feed || c.testTitle} also serves ${c.sharedWith.join(', ')}`);
      }
      m.executionIds = [...new Set(m.executionIds)];

      // ---- suite-specific status + results
      const pw = tests.flatMap((t) => t.results);
      const finalResults = tests.map((t) => t.results[t.results.length - 1]).filter(Boolean);
      const pwAgg = !finalResults.length ? 'NOT RUN'
        : finalResults.some((r) => pwStatus(r.status) === 'FAIL') ? 'FAIL'
          : finalResults.every((r) => pwStatus(r.status) === 'PASS') ? 'PASS' : 'SKIPPED';
      const blockedPhase = ph && ph.state === 'NOT RUN' ? ph : null;

      if (suite === 'e2e-execute-brv4') {
        if (m.applicable) {
          m.status = blockedPhase ? 'NOT RUN' : pwAgg;
          m.statusSource = 'Playwright result of the feed upload test(s)';
          if (blockedPhase) m.notes.push(`Not run: ${blockedPhase.reason}`);
          for (const f of executeFeeds) {
            m.notes.push(`Feed ${f.file} (role ${f.role}, phase ${f.phase}) is mapped to ${f.cases.join(', ')} in data/feeds.brv4.json.`);
            if (f.cases.length > 1) m.sharedRelationships.push(`${f.file} is shared by ${f.cases.join(', ')} - one upload, not independent executions.`);
            if (!m.testData.some((t) => t.feedFile === f.file) && m.status !== 'NOT RUN') m.missing.push(`no captured copy of feed ${f.file}`);
            const runRec = readJson(path.join(runDir, '_raw', 'snapshots', 'after-e2e-execute-brv4', 'runs', `${safeName(f.file)}.json`));
            if (runRec && Date.parse(runRec.uploadedAt) >= runStartedAt) {
              if (runRec.runId) m.executionIds.push(runRec.runId);
              if (runRec.error) m.notes.push(`Upload of ${f.file} recorded an error: ${runRec.error}`);
              // The ZIP is always named ingestion-artifacts-<runId>.zip, whatever its folder is called.
              if (!runRec.zipPath || !m.generatedFiles.some((g) => g.path.includes(`ingestion-artifacts-${runRec.runId}.zip`))) {
                m.missing.push(`no generated artifacts captured for run ${runRec.runId || '(none)'} of ${f.file}`);
              }
            } else if (m.status !== 'NOT RUN') m.missing.push(`no run record from this rerun for ${f.file}`);
          }
          m.executionIds = [...new Set(m.executionIds)];
          if (finalResults.length && !m.recordings.length) m.missing.push('no recording produced for this browser test');
          if (m.status === 'PASS' && m.missing.length === 0) m.evidenceStatus = 'COMPLETE';
          else if (m.status === 'NOT RUN') m.evidenceStatus = 'MISSING';
          else m.evidenceStatus = m.recordings.length || m.testData.length ? (m.missing.length ? 'PARTIAL' : 'COMPLETE') : 'MISSING';
        }
      } else {
        const resultName = suite === 'e2e-validate-brv4' ? 'validation-result.json' : 'db-verification-result.json';
        const resultPath = path.join(tcDir, resultName);
        let v = readJson(resultPath);
        // Not captured by a test (e.g. validate's beforeAll placeholders, or a
        // test that never reached afterEach): take the suite's own post-phase
        // snapshot of the verdict file.
        if (!v) {
          const snap = snapshot(suite, tc.id);
          if (snap && (m.applicable || (suite === 'e2e-validate-brv4' && !dbIds.has(tc.id)))) {
            v = { ...snap, _writtenByThisTest: false, _source: `_raw/snapshots/after-${suite}/verdicts/${tc.id}.json` };
            writeJson(resultPath, v);
          }
        }
        if (v) {
          const fresh = isFresh(v);
          m.verdict = v.verdict;
          m[suite === 'e2e-validate-brv4' ? 'validationResult' : 'dbVerificationResult'] = resultName;
          m.expectedVsActual = (v.checkResults || []).map((c) => ({ check: c.description, expected: 'condition holds', actual: c.detail, passed: c.passed }));
          m.records = { runId: v.runId || null, feedFile: v.feedFile || null, feedDate: v.feedDate || null, generation: v.generation, decidedAt: v.decidedAt, freshThisRun: fresh };
          if (v.runId) m.executionIds.push(v.runId);
          m.executionIds = [...new Set(m.executionIds)];
          if (!fresh) m.notes.push(`Verdict file was NOT written during this rerun (decidedAt ${v.decidedAt}) - it is carried over from an earlier run.`);
        }

        if (suite === 'e2e-validate-brv4') {
          if (m.applicable) {
            m.status = blockedPhase ? 'NOT RUN' : !finalResults.length ? 'NOT RUN' : (v && isFresh(v) ? v.verdict : pwAgg);
            m.statusSource = 'Verdict written by tests/validation-brv4 (judgeBrv4), cross-checked with the Playwright result';
            if (blockedPhase) m.notes.push(`Not run: ${blockedPhase.reason}`);
            if (v && v.verdict === 'PASS' && pwAgg !== 'PASS') m.notes.push(`Playwright reported ${pwAgg} although the verdict is PASS.`);
            // Recording: validation never opens a browser - link the upstream execute recording.
            m.recordings = [];
            m.notes.push('Recording: NOT APPLICABLE - e2e-validate-brv4 only reads downloaded artifacts; no browser interaction.');
            const execDir = path.join(runDir, SUITE_DIR['e2e-execute-brv4'], tc.id);
            const execManifestRuns = new Set();
            for (const c of readCaptures(execDir)) for (const u of c.uploads || []) if (u.runId) execManifestRuns.add(u.runId);
            const confirmed = v && v.runId && execManifestRuns.has(v.runId);
            for (const f of listFiles(execDir).filter((p) => p.endsWith('.webm'))) {
              m.linkedUpstream.push({ kind: 'recording', path: posix(path.relative(tcDir, f)), relationship: confirmed ? `confirmed - same runId ${v.runId}` : 'unconfirmed - runId does not match this rerun\'s upload' });
            }
            if (!m.linkedUpstream.length) m.missing.push('no upstream e2e-execute-brv4 recording to link');
            if (v && !confirmed) m.missing.push(`validation runId ${v.runId || '(none)'} is not an upload captured in this rerun`);
            if (!v) m.missing.push('no validation-result.json');
            else if (!isFresh(v)) m.missing.push('validation result not refreshed by this rerun');
            m.evidenceStatus = m.status === 'NOT RUN' ? 'MISSING' : m.missing.length ? 'PARTIAL' : 'COMPLETE';
          } else if (v && !dbIds.has(tc.id)) {
            // The 24 cases outside both feed and DB scope: validate's beforeAll
            // writes their BLOCKED placeholder - that IS this suite's result.
            // A verdict decided by some other route is left alone by that
            // placeholder (recordBlockedUnlessDecidedBrv4), so this suite did
            // not verify it.
            if (isFresh(v)) {
              m.status = v.verdict;
              m.statusSource = 'BLOCKED placeholder written by e2e-validate-brv4 beforeAll (not listed as a test)';
            } else {
              m.status = 'NOT VERIFIED';
              m.statusSource = `Carried-over ${v.verdict} verdict decided ${v.decidedAt} outside the three suites ("${v.actualSummary}") - not re-verified by this rerun`;
            }
            m.evidenceStatus = 'NOT APPLICABLE';
          }
        } else if (m.applicable) {
          m.status = blockedPhase ? 'NOT RUN' : !finalResults.length ? 'NOT RUN' : (v && isFresh(v) ? v.verdict : pwAgg);
          m.statusSource = 'Verdict written by tests/e2e-brv4/db-verified-cases.brv4.spec.ts, cross-checked with the Playwright result';
          if (blockedPhase) m.notes.push(`Not run: ${blockedPhase.reason}`);
          const ref = sqlReferenceForTc(tc.id);
          if (ref) {
            writeSqlReference(tcDir, tc.id, ref);
            m.queryReference = 'query-reference.sql';
            m.dbReferences = { source: ref.source, caseLines: ref.caseLines, helpers: ref.helpers, tables: ref.tables, columns: ref.columns, readStatements: ref.statements.filter((s) => s.kind === 'READ').length, writeStatements: ref.statements.filter((s) => s.kind === 'WRITE').length };
            if (ref.statements.some((s) => s.kind === 'WRITE')) m.notes.push(`This case's code path includes ${ref.statements.filter((s) => s.kind === 'WRITE').length} DB write statement(s) (precondition seeding) - see query-reference.sql.`);
          } else m.missing.push('case definition not found for query reference');
          const released = tests.flatMap((t) => t.results.flatMap((r) => (r.annotations || []))).concat(tests.flatMap((t) => t.annotations)).filter((a) => a.type === 'hr2-leftovers-released');
          for (const a of released) m.notes.push(`releaseFailedHr2Leftovers deleted unprocessed activity rows: ${a.description}`);
          if (finalResults.length && !m.recordings.length) m.missing.push('no recording produced for this browser test');
          if (!v) m.missing.push('no db-verification-result.json');
          else if (!isFresh(v)) m.missing.push('DB verification result not refreshed by this rerun');
          if (finalResults.length && !m.testData.length) m.notes.push('No feed upload was captured for this case.');
          m.evidenceStatus = m.status === 'NOT RUN' ? 'MISSING' : m.missing.length ? 'PARTIAL' : 'COMPLETE';
        }
      }

      if (!m.applicable && m.status === 'NOT APPLICABLE') m.notes.push('Recording: NOT APPLICABLE.');
      m.logs = [...new Set(m.logs)];
      m.missing = [...new Set(m.missing)];
      m.inEvidenceFolder = included;
      if (!included) m.notes.push(`Kept out of ${SUITE_DIR[suite].split('/')[0]}/ - this TC is not decided by ${suite}.`);
      writeJson(path.join(tcDir, 'evidence-manifest.json'), m);
      const durationMs = m.attempts.reduce((n, a) => n + (a.durationMs || 0), 0);
      const testTitles = m.attempts.map((a) => a.test).filter((t, i, all) => t && all.indexOf(t) === i);
      if (!included) {
        fs.mkdirSync(path.dirname(excludedDir), { recursive: true });
        fs.renameSync(tcDir, excludedDir);
      }
      row.suites[suite] = { included, durationMs, tests: testTitles, attemptsCount: m.attempts.length, detail: { statusSource: m.statusSource, executionIds: m.executionIds, expectedVsActual: m.expectedVsActual, notes: m.notes, screenshots: m.screenshots.map((x) => rel(path.join(tcDir, x))), tables: m.dbReferences ? m.dbReferences.tables : [] }, status: m.status, verdict: m.verdict, applicable: m.applicable, evidenceStatus: m.evidenceStatus, dir: rel(tcDir), manifest: rel(path.join(tcDir, 'evidence-manifest.json')), recordings: m.recordings.map((r) => rel(path.join(tcDir, r.path))), linkedRecordings: m.linkedUpstream.map((r) => rel(path.join(tcDir, r.path))), testData: m.testData.filter((t) => t.path).map((t) => rel(path.join(tcDir, t.path))), generated: m.generatedFiles.filter((g) => /\.zip$/.test(g.path)).map((g) => rel(path.join(tcDir, g.path))), result: m.validationResult || m.dbVerificationResult ? rel(path.join(tcDir, m.validationResult || m.dbVerificationResult)) : null, sql: m.queryReference ? rel(path.join(tcDir, m.queryReference)) : null, missing: m.missing };
    }

    // ---- overall: the project's own rule (scripts/regen-final-report-brv4.js
    // verdictFor) - the final verdict file, BLOCKED when absent - but only if
    // that verdict was actually written during this rerun.
    const finalV = snapshot('e2e-db-brv4', tc.id) || snapshot('e2e-validate-brv4', tc.id);
    if (!finalV) row.overall = 'BLOCKED';
    else if (!isFresh(finalV)) row.overall = 'NOT VERIFIED';
    else row.overall = finalV.verdict;
    row.overallNote = !finalV ? 'no verdict file' : !isFresh(finalV) ? `not re-verified by this rerun - carried-over ${finalV.verdict} decided ${finalV.decidedAt} ("${finalV.actualSummary}")` : (finalV.notes || '').slice(0, 300);
    rows.push(row);
  }

  // ------------------------------------------------- report test deep links
  const reportIndex = path.join(runDir, 'playwright-report', 'index.html');
  const reportTests = new Map();
  if (fs.existsSync(reportIndex)) {
    const html = fs.readFileSync(reportIndex, 'utf8');
    // 1.63 embeds it as <template id="playwrightReportBase64">; older versions as a window global.
    const m = html.match(/id="playwrightReportBase64">data:application\/zip;base64,([^<]+)</) || html.match(/window\.playwrightReportBase64\s*=\s*"data:application\/zip;base64,([^"]+)"/);
    if (m) {
      const zip = new AdmZip(Buffer.from(m[1], 'base64'));
      for (const e of zip.getEntries()) {
        if (e.entryName === 'report.json') continue;
        const file = JSON.parse(e.getData().toString('utf8'));
        for (const t of file.tests || []) {
          for (const id of `${t.title}`.match(/TC-BR-\d+/g) || []) {
            if (!reportTests.has(id)) reportTests.set(id, []);
            reportTests.get(id).push({ testId: t.testId, project: t.projectName, title: t.title });
          }
          const feed = (t.title.match(/upload (\S+)/) || [])[1];
          for (const id of (feeds.find((f) => f.file === feed)?.cases || [])) {
            if (!reportTests.has(id)) reportTests.set(id, []);
            if (!reportTests.get(id).some((x) => x.testId === t.testId)) reportTests.get(id).push({ testId: t.testId, project: t.projectName, title: t.title });
          }
        }
      }
    }
  }
  for (const r of rows) r.reportTests = (reportTests.get(r.tcId) || []).map((t) => ({ ...t, href: `playwright-report/index.html#?testId=${t.testId}` }));

  // ---------------------------------------------------------- summaries
  const count = (arr) => arr.reduce((a, k) => ((a[k] = (a[k] || 0) + 1), a), {});
  const summary = {
    runDir: posix(path.relative(ROOT, runDir)),
    startedAt: phaseLog.startedAt,
    finishedAt: phaseLog.finishedAt,
    phases: phaseLog.phases,
    totalTcs: rows.length,
    perSuite: Object.fromEntries(SUITES.map((s) => [s, {
      applicable: rows.filter((r) => r.suites[s].applicable).length,
      playwrightTests: results[s].tests.length,
      status: count(rows.map((r) => r.suites[s].status)),
      evidence: count(rows.filter((r) => r.suites[s].applicable).map((r) => r.suites[s].evidenceStatus)),
      recordings: rows.reduce((n, r) => n + r.suites[s].recordings.length, 0),
    }])),
    overall: count(rows.map((r) => r.overall)),
    tcFolders: rows.reduce((n, r) => n + SUITES.filter((s) => r.suites[s].included).length, 0),
    tcFoldersPerSuite: Object.fromEntries(SUITES.map((s) => [s, rows.filter((r) => r.suites[s].included).length])),
  };
  writeJson(path.join(runDir, 'evidence-summary.json'), { summary, rows });
  const csvCols = ['TC ID', 'Rule', 'Execute', 'Validate', 'DB', 'Overall', 'Execute evidence', 'Validate evidence', 'DB evidence', 'Missing'];
  const csvEsc = (x) => { const s = String(x ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  fs.writeFileSync(path.join(runDir, 'evidence-summary.csv'), [csvCols.join(','), ...rows.map((r) => [
    r.tcId, r.rule, r.suites['e2e-execute-brv4'].status, r.suites['e2e-validate-brv4'].status, r.suites['e2e-db-brv4'].status, r.overall,
    r.suites['e2e-execute-brv4'].evidenceStatus, r.suites['e2e-validate-brv4'].evidenceStatus, r.suites['e2e-db-brv4'].evidenceStatus,
    SUITES.flatMap((s) => r.suites[s].missing.map((x) => `${s}: ${x}`)).join(' | '),
  ].map(csvEsc).join(','))].join('\n') + '\n');

  writeIndexHtml(runDir, summary, rows);
  const linkCheck = verifyLinks(runDir);
  const secretCheck = scanForSecrets(runDir);
  writeJson(path.join(runDir, '_raw', 'verification.json'), { linkCheck, secretCheck });
  return { summary, linkCheck, secretCheck };
}

// ------------------------------------------------------------ index html

// Same look as the Playwright HTML report (header with status filters and
// search, collapsible chips per suite, status icons, project labels, durations;
// a per-TC detail view with inline video/screenshot and attachments), so the
// two read as one. Static HTML - every link and media src is in the source,
// which is what verifyLinks() checks.
function writeIndexHtml(runDir, summary, rows) {
  const ICON = {
    pass: '<svg class="icon pass" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>',
    fail: '<svg class="icon fail" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>',
    skip: '<svg class="icon skip" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M8 0a8 8 0 110 16A8 8 0 018 0zM1.5 8a6.5 6.5 0 0010.535 5.096L2.904 3.965A6.47 6.47 0 001.5 8zm11.596 4.035L3.965 2.904A6.5 6.5 0 0113.096 12.035z"/></svg>',
    chevron: '<svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M12.78 6.22a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06 0L3.22 7.28a.75.75 0 011.06-1.06L8 9.94l3.72-3.72a.75.75 0 011.06 0z"/></svg>',
    file: '<svg class="icon muted" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M3.75 1.5a.25.25 0 00-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75zm5.75.56v2.19c0 .138.112.25.25.25h2.19L9.5 2.06zM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0112.25 15h-8.5A1.75 1.75 0 012 13.25V1.75z"/></svg>',
    folder: '<svg class="icon muted" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>',
  };
  const kind = (s) => (s === 'PASS' ? 'pass' : s === 'FAIL' ? 'fail' : 'skip');
  const icon = (s) => ICON[kind(s)];
  const ms = (n) => (!n ? '' : n < 1000 ? `${n}ms` : n < 60000 ? `${(n / 1000).toFixed(1)}s` : n < 3600000 ? `${(n / 60000).toFixed(1)}m` : `${(n / 3600000).toFixed(1)}h`);
  const LABEL = { 'e2e-execute-brv4': 0, 'e2e-validate-brv4': 1, 'e2e-db-brv4': 2 };
  const label = (s) => `<span class="label label-${LABEL[s] ?? 3}">${esc(s)}</span>`;
  const statusText = (s) => `<span class="st st-${kind(s)}">${esc(s)}</span>`;
  const att = (href, text, ic = ICON.file) => `<div class="att">${ic}<a href="${esc(href)}">${esc(text)}</a></div>`;
  const base = (p) => p.split('/').pop();

  const groups = [
    { title: '01-e2e-application › e2e-execute-brv4', sub: 'Uploads the feeds and downloads the output files the validation judges', suite: 'e2e-execute-brv4' },
    { title: '01-e2e-application › e2e-validate-brv4', sub: 'Offline validation of the downloaded output files', suite: 'e2e-validate-brv4' },
    { title: '02-e2e-database › e2e-db-brv4', sub: 'Uploads through the app, then verifies the result directly in the database', suite: 'e2e-db-brv4' },
  ];

  const listRow = (r, suite) => {
    const x = r.suites[suite];
    return `<a class="test" href="#${esc(r.tcId)}" data-overall="${esc(r.overall)}" data-text="${esc(`${r.tcId} ${r.rule} ${r.topic} ${x.status} ${suite}`.toLowerCase())}">` +
      `${icon(x.status)}<span class="test-main"><span class="test-title">${esc(r.tcId)} <span class="muted">${esc(r.rule)}</span> ${label(suite)}</span>` +
      `<span class="test-loc">${esc(r.topic || '')}</span></span><span class="dur">${esc(ms(x.durationMs))}</span></a>`;
  };
  const notRun = rows.filter((r) => !SUITES.some((s) => r.suites[s].included));
  const chip = (title, sub, inner, badge, open = true, id = '') =>
    `<details class="chip"${open ? ' open' : ''}${id ? ` id="${id}"` : ''}><summary class="chip-header">${ICON.chevron}<span class="chip-title">${esc(title)}</span>${badge}<span class="chip-sub">${esc(sub)}</span></summary><div class="chip-body">${inner}</div></details>`;

  const listHtml = groups.map((g) => {
    const rs = rows.filter((r) => r.suites[g.suite].included);
    return chip(g.title, g.sub, rs.map((r) => listRow(r, g.suite)).join(''), `<span class="counter">${rs.length}</span>`);
  }).join('') + chip('Not executed by any suite', 'Not executable (BLOCKED), or a carried-over verdict no suite re-verifies (NOT VERIFIED)', notRun.map((r) =>
    `<a class="test" href="#${esc(r.tcId)}" data-overall="${esc(r.overall)}" data-text="${esc(`${r.tcId} ${r.rule} ${r.topic} ${r.overall}`.toLowerCase())}">${icon(r.overall)}<span class="test-main"><span class="test-title">${esc(r.tcId)} <span class="muted">${esc(r.rule)}</span></span><span class="test-loc">${esc(r.overallNote)}</span></span><span class="dur">${esc(r.overall)}</span></a>`,
  ).join(''), `<span class="counter">${notRun.length}</span>`, false);

  const suitePanel = (r, suite) => {
    const x = r.suites[suite];
    if (!x.included) return '';
    const d = x.detail;
    const reportLinks = r.reportTests.filter((t) => t.project === suite).map((t) => att(t.href, `Open in Playwright report: ${t.title}`));
    const checks = d.expectedVsActual.length
      ? `<div class="sec-title">Checks</div>` + d.expectedVsActual.map((c) => `<div class="check">${icon(c.passed ? 'PASS' : 'FAIL')}<div><div>${esc(c.check)}</div><div class="mono muted">${esc(c.actual)}</div></div></div>`).join('')
      : '';
    const videos = x.recordings.map((p) => `<div class="media"><video controls preload="none" src="${esc(p)}"></video><div>${att(p, base(p))}</div></div>`).join('');
    const shots = d.screenshots.map((p) => `<div class="media"><a href="${esc(p)}"><img loading="lazy" src="${esc(p)}" alt="Final screenshot of ${esc(r.tcId)}"></a></div>`).join('');
    const linked = x.linkedRecordings.map((p) => att(p, `Execution recording (e2e-execute-brv4): ${base(p)}`));
    const files = [
      ...x.testData.map((p) => att(p, `Test data: ${base(p)}`)),
      ...x.generated.map((p) => att(p, `Output files: ${base(p)}`)),
      ...(x.result ? [att(x.result, base(x.result))] : []),
      ...(x.sql ? [att(x.sql, 'SQL run against the DB: query-reference.sql')] : []),
      att(x.manifest, 'evidence-manifest.json'),
      att(`${x.dir}/`, `Folder: ${x.dir}/`, ICON.folder),
    ];
    const missing = x.missing.length ? `<div class="sec-title">Missing evidence</div>${x.missing.map((m) => `<div class="check">${ICON.fail}<div>${esc(m)}</div></div>`).join('')}` : '';
    return chip(suite, `Evidence ${x.evidenceStatus}${x.durationMs ? ` · ${ms(x.durationMs)}` : ''}`,
      `<div class="pad">` +
      (d.executionIds.length ? `<div class="kv"><span class="muted">Run ID${d.executionIds.length > 1 ? 's' : ''}</span> <span class="mono">${d.executionIds.map(esc).join(', ')}</span></div>` : '') +
      (d.tables.length ? `<div class="kv"><span class="muted">Tables</span> <span class="mono">${d.tables.map(esc).join(', ')}</span></div>` : '') +
      (reportLinks.length ? reportLinks.join('') : '') +
      checks + missing +
      (videos ? `<div class="sec-title">Videos</div>${videos}` : '') +
      (shots ? `<div class="sec-title">Screenshots</div>${shots}` : '') +
      (linked.length ? `<div class="sec-title">Execution recording</div>${linked.join('')}` : '') +
      `<div class="sec-title">Attachments</div>${files.join('')}` +
      `</div>`, statusText(x.status), true);
  };

  const detailHtml = rows.map((r) => {
    const panels = SUITES.map((s) => suitePanel(r, s)).join('');
    return `<section class="detail" id="${esc(r.tcId)}" hidden>` +
      `<a class="back" href="#">« All test cases</a>` +
      `<div class="test-case-title">${icon(r.overall)} ${esc(r.tcId)} <span class="muted">${esc(r.rule)}</span></div>` +
      `<div class="test-case-loc">${esc(r.topic || '')}</div>` +
      `<div class="overall">Overall ${statusText(r.overall)} <span class="muted">${esc(r.overallNote)}</span></div>` +
      (panels || `<div class="empty">No suite executes this test case, so there is no evidence folder for it.</div>`) +
      `</section>`;
  }).join('\n');

  const counts = { All: rows.length };
  for (const r of rows) counts[r.overall] = (counts[r.overall] || 0) + 1;
  const filters = [['All', 'All'], ['PASS', 'Passed'], ['FAIL', 'Failed'], ['BLOCKED', 'Blocked'], ['NOT VERIFIED', 'Not verified']]
    .map(([k, t]) => `<a class="filter${k === 'All' ? ' selected' : ''}" href="#" data-filter="${esc(k)}">${esc(t)} <span class="counter">${counts[k] || 0}</span></a>`).join('');

  const phaseRows = (summary.phases || []).map((p) => `<tr><td>${esc(p.order)}</td><td>${label(p.suite)}</td><td>${statusText(p.state === 'COMPLETED' ? 'PASS' : p.state)} <span class="muted">${esc(p.reason || '')}</span></td><td class="mono">${esc((p.startedAt || '').replace('T', ' ').slice(0, 19))}</td><td class="mono">${esc((p.finishedAt || '').replace('T', ' ').slice(0, 19))}</td></tr>`).join('');
  const suiteRows = SUITES.map((s) => {
    const x = summary.perSuite[s];
    return `<tr><td>${label(s)}</td><td>${summary.tcFoldersPerSuite[s]}</td><td>${x.playwrightTests}</td><td>${esc(Object.entries(x.status).filter(([k]) => k !== 'NOT APPLICABLE').map(([k, v]) => `${k} ${v}`).join(', '))}</td><td>${x.recordings}</td></tr>`;
  }).join('');
  const totalMs = Date.parse(summary.finishedAt || '') - Date.parse(summary.startedAt || '');
  const overview = chip('Run overview', `${summary.totalTcs} TCs · ${summary.tcFolders} TC evidence folders`,
    `<div class="pad"><div class="sec-title">Phases (strict order)</div><div class="tbl"><table><tr><th>#</th><th>Suite</th><th>Result</th><th>Started (UTC)</th><th>Finished (UTC)</th></tr>${phaseRows}</table></div>` +
    `<div class="sec-title">Per suite</div><div class="tbl"><table><tr><th>Suite</th><th>TC folders</th><th>Playwright tests</th><th>Status</th><th>Recordings</th></tr>${suiteRows}</table></div>` +
    `<p class="muted">Overall follows the project's existing rule (each TC's final verdict file; BLOCKED when absent) and shows NOT VERIFIED when that verdict was not written during this rerun. Open this page and the Playwright report from disk (after extracting the zip) so the relative links resolve.</p></div>`,
    '', false);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>BRv4 Evidence Report</title>
<style>
:root{--fg:#1f2328;--muted:#656d76;--bg:#fff;--subtle:#f6f8fa;--border:#d0d7de;--hover:#f6f8fa;--accent:#0969da;--pass:#1a7f37;--fail:#d1242f;--skip:#9a6700;--counter:rgba(175,184,193,0.2);
--l0-bg:#ddf4ff;--l0-fg:#0969da;--l1-bg:#fff8c5;--l1-fg:#7d4e00;--l2-bg:#fbefff;--l2-fg:#8250df;--l3-bg:#eaeef2;--l3-fg:#57606a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--fg:#e6edf3;--muted:#7d8590;--bg:#0d1117;--subtle:#161b22;--border:#30363d;--hover:#161b22;--accent:#2f81f7;--pass:#3fb950;--fail:#f85149;--skip:#d29922;--counter:rgba(110,118,129,0.4);
--l0-bg:rgba(56,139,253,0.15);--l0-fg:#58a6ff;--l1-bg:rgba(187,128,9,0.15);--l1-fg:#d29922;--l2-bg:rgba(163,113,247,0.15);--l2-fg:#bc8cff;--l3-bg:rgba(110,118,129,0.4);--l3-fg:#8b949e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
.wrap{max-width:1280px;margin:0 auto;padding:16px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}
.header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:12px}
.search{flex:1 1 320px;min-width:0;padding:5px 12px;font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--border);border-radius:6px;outline:none}
.search:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(9,105,218,0.3)}
.filters{display:flex;flex-wrap:wrap;gap:4px 14px}
.filter{color:var(--fg);padding:2px 0;white-space:nowrap}.filter.selected{font-weight:600}
.counter{display:inline-block;min-width:20px;padding:0 6px;font-size:12px;font-weight:500;line-height:18px;text-align:center;background:var(--counter);border-radius:2em;color:var(--fg)}
.meta{display:flex;flex-wrap:wrap;gap:4px 16px;justify-content:space-between;color:var(--muted);font-size:12px;margin-bottom:12px}
.meta a{color:var(--muted);text-decoration:underline}
.chip{border:1px solid var(--border);border-radius:6px;margin-bottom:12px;background:var(--bg)}
.chip-header{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:8px 12px;background:var(--subtle);border-radius:6px;cursor:pointer;list-style:none;font-weight:600}
.chip[open]>.chip-header{border-bottom:1px solid var(--border);border-radius:6px 6px 0 0}
.chip-header::-webkit-details-marker{display:none}
.chip-title{overflow-wrap:anywhere}.chip-sub{flex-basis:100%;font-weight:400;font-size:12px;color:var(--muted);padding-left:24px}
.chevron{width:16px;height:16px;fill:var(--muted);transform:rotate(-90deg);transition:transform .1s;flex:none}
.chip[open]>.chip-header .chevron{transform:none}
.test{display:flex;align-items:flex-start;gap:8px;padding:8px 12px 8px 16px;border-top:1px solid var(--border);color:var(--fg);cursor:pointer}
.chip-body>.test:first-child{border-top:none}
.test:hover{background:var(--hover);text-decoration:none}
.test-main{flex:1;min-width:0;display:flex;flex-direction:column}
.test-title{font-weight:500;overflow-wrap:anywhere}.test-loc{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.dur{color:var(--muted);font-size:12px;white-space:nowrap;padding-top:2px}
.icon{width:16px;height:16px;flex:none;margin-top:2px}.icon.pass{fill:var(--pass)}.icon.fail{fill:var(--fail)}.icon.skip{fill:var(--skip)}.icon.muted{fill:var(--muted)}
.label{display:inline-block;padding:0 8px;font-size:12px;font-weight:500;line-height:18px;border-radius:2em;margin-left:4px;white-space:nowrap}
.label-0{background:var(--l0-bg);color:var(--l0-fg)}.label-1{background:var(--l1-bg);color:var(--l1-fg)}.label-2{background:var(--l2-bg);color:var(--l2-fg)}.label-3{background:var(--l3-bg);color:var(--l3-fg)}
.st{font-weight:600;font-size:12px}.st-pass{color:var(--pass)}.st-fail{color:var(--fail)}.st-skip{color:var(--skip)}
.back{display:inline-block;margin-bottom:12px}
.test-case-title{display:flex;align-items:center;gap:8px;font-size:20px;font-weight:600;overflow-wrap:anywhere}
.test-case-title .icon{width:20px;height:20px;margin:0}
.test-case-loc{color:var(--muted);margin-bottom:8px}
.overall{margin-bottom:16px}
.pad{padding:12px 16px}
.sec-title{font-weight:600;margin:14px 0 6px}.pad>.sec-title:first-child{margin-top:0}
.kv{margin-bottom:6px}
.att{display:flex;align-items:flex-start;gap:6px;padding:3px 0;overflow-wrap:anywhere}.att a{min-width:0}
.check{display:flex;gap:8px;padding:4px 0;border-top:1px solid var(--border)}.check:first-of-type{border-top:none}
.media{margin:6px 0 10px}.media video,.media img{display:block;max-width:100%;border:1px solid var(--border);border-radius:6px}
.media video{width:720px;background:#000}
.tbl{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}th{color:var(--muted);font-weight:600}
.empty{padding:16px;color:var(--muted);border:1px dashed var(--border);border-radius:6px}
.hidden{display:none !important}
</style></head><body><div class="wrap">
<div id="list">
<div class="header"><input class="search" id="q" type="search" placeholder="Search test cases" aria-label="Search test cases"><div class="filters">${filters}</div></div>
<div class="meta"><span>BRv4 evidence report · ${esc(summary.runDir)} · ${summary.totalTcs} TCs</span><span>${esc((summary.startedAt || '').replace('T', ' ').slice(0, 19))} UTC${totalMs > 0 ? ` · Total time: ${esc(ms(totalMs))}` : ''} · <a href="playwright-report/index.html">Playwright report</a> · <a href="01-e2e-application/">01-e2e-application</a> · <a href="02-e2e-database/">02-e2e-database</a></span></div>
${overview}
${listHtml}
</div>
${detailHtml}
</div>
<script>
(function(){
  var list=document.getElementById('list'),q=document.getElementById('q'),filter='All';
  function apply(){
    var t=q.value.trim().toLowerCase();
    document.querySelectorAll('#list .test').forEach(function(a){
      var ok=(filter==='All'||a.getAttribute('data-overall')===filter)&&(!t||a.getAttribute('data-text').indexOf(t)>=0);
      a.classList.toggle('hidden',!ok);
    });
  }
  q.addEventListener('input',apply);
  document.querySelectorAll('.filter').forEach(function(f){f.addEventListener('click',function(e){
    e.preventDefault();filter=f.getAttribute('data-filter');
    document.querySelectorAll('.filter').forEach(function(x){x.classList.toggle('selected',x===f)});apply();
  })});
  function route(){
    var id=decodeURIComponent(location.hash.slice(1)),d=id&&document.getElementById(id);
    document.querySelectorAll('section.detail').forEach(function(s){s.hidden=s!==d});
    list.hidden=!!(d&&d.tagName==='SECTION');
    if(!d)document.querySelectorAll('video').forEach(function(v){v.pause()});
    window.scrollTo(0,0);
  }
  window.addEventListener('hashchange',route);route();
})();
</script>
</body></html>
`;
  fs.writeFileSync(path.join(runDir, 'evidence-index.html'), html);
}

// --------------------------------------------------------- verification

function verifyLinks(runDir) {
  const broken = [];
  let checked = 0;
  const check = (fromFile, href) => {
    if (/^(https?:|mailto:|data:|blob:|javascript:)/.test(href)) return;
    const [p, hash] = href.split('#');
    if (!p) return; // same-page anchor
    if (path.isAbsolute(p) || /^[a-z]:/i.test(p) || p.startsWith('file:')) { broken.push({ from: posix(path.relative(runDir, fromFile)), href, reason: 'absolute path' }); return; }
    checked++;
    const target = path.resolve(path.dirname(fromFile), decodeURI(p));
    if (!target.startsWith(runDir)) { broken.push({ from: posix(path.relative(runDir, fromFile)), href, reason: 'escapes run folder' }); return; }
    if (!fs.existsSync(target)) { broken.push({ from: posix(path.relative(runDir, fromFile)), href, reason: 'missing target' }); return; }
    if (hash && /\.html$/.test(target) && !hash.startsWith('?')) {
      const html = fs.readFileSync(target, 'utf8');
      if (!html.includes(`id="${hash}"`)) broken.push({ from: posix(path.relative(runDir, fromFile)), href, reason: `missing anchor #${hash}` });
    }
  };
  const hrefs = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const index = path.join(runDir, 'evidence-index.html');
  if (fs.existsSync(index)) for (const h of hrefs(index)) check(index, h);
  const dataDir = path.join(runDir, 'playwright-report', 'data');
  let linkPages = 0;
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir).filter((x) => x.endsWith('.html'))) {
      const p = path.join(dataDir, f);
      linkPages++;
      for (const h of hrefs(p)) check(p, h);
    }
  }
  return { checked, linkPages, broken: broken.length, brokenSample: broken.slice(0, 50) };
}

// Reports only counts and file names - never the secret values themselves.
function scanForSecrets(runDir) {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return { scanned: 0, hits: [] };
  const secrets = [];
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (/pass|secret|token|key|host|user/i.test(m[1]) && m[2].length >= 6) secrets.push({ name: m[1], value: m[2] });
  }
  const hits = [];
  let scanned = 0;
  for (const f of listFiles(runDir)) {
    if (!/\.(json|txt|log|sql|html|csv|md)$/i.test(f)) continue;
    scanned++;
    const text = fs.readFileSync(f, 'utf8');
    for (const s of secrets) if (text.includes(s.value)) hits.push({ file: posix(path.relative(runDir, f)), envVar: s.name });
  }
  return { scanned, secretsChecked: secrets.map((s) => s.name), hits };
}

module.exports = { assemble, sqlReferenceForTc, writeSqlReference };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/assemble-evidence-brv4.js artifacts/post-rerun-<stamp>'); process.exit(2); }
  const { summary, linkCheck, secretCheck } = assemble(dir);
  console.log(JSON.stringify({ perSuite: summary.perSuite, overall: summary.overall, linkCheck: { checked: linkCheck.checked, linkPages: linkCheck.linkPages, broken: linkCheck.broken }, secretHits: secretCheck.hits.length }, null, 2));
}
