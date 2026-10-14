import * as fs from 'fs';
import * as path from 'path';
import type { TestInfo } from '@playwright/test';
import type { ConsolePage } from '../pages/ConsolePage';
import { loadFeedsBrv4 } from './registry.brv4';
import { E2E_ROOT_BRV4, VERDICT_DIR_BRV4 } from './verdict-store.brv4';

// Per-TC evidence capture for evidence runs (scripts/rerun-evidence-brv4.js),
// active only when BRV4_EVIDENCE_ROOT is set - every function here is a no-op
// otherwise, so ordinary runs of the three BRv4 projects behave exactly as
// before. Captures what is only knowable while the test runs (the exact feed
// bytes uploaded - data/feeds/ALLSTATE.LNA.BR-* are rewritten by later DB
// cases - the run ids, the downloaded ZIPs, the verdict as written by THIS
// suite before a later suite rewrites the same verdict file). Recordings,
// screenshots and manifests are added after the run by
// scripts/assemble-evidence-brv4.js, once Playwright has finished writing them.

export type SuiteBrv4 = 'e2e-execute-brv4' | 'e2e-validate-brv4' | 'e2e-db-brv4';

export const EVIDENCE_ROOT_BRV4 = process.env.BRV4_EVIDENCE_ROOT ? path.resolve(process.env.BRV4_EVIDENCE_ROOT) : '';

export const SUITE_DIR_BRV4: Record<SuiteBrv4, string> = {
  'e2e-execute-brv4': '01-e2e-application/e2e-execute-brv4',
  'e2e-validate-brv4': '01-e2e-application/e2e-validate-brv4',
  'e2e-db-brv4': '02-e2e-database/e2e-db-brv4',
};

export function tcEvidenceDirBrv4(suite: SuiteBrv4, tcId: string): string {
  return path.join(EVIDENCE_ROOT_BRV4, SUITE_DIR_BRV4[suite], tcId);
}

interface UploadTrace { sourcePath: string; feedDate: string; runId: string; chosenAt: string; content: Buffer }
interface DownloadTrace { zipPath: string; runId: string; savedAt: string }
interface ConsoleTrace { uploads: UploadTrace[]; downloads: DownloadTrace[] }

const traces = new WeakMap<ConsolePage, ConsoleTrace>();
const WORKER_STARTED_AT = Date.now();

/**
 * Wraps this test's ConsolePage instance (not the class) so every feed it
 * uploads and every artifacts ZIP it downloads is recorded. The feed's bytes
 * are kept at the moment it is chosen, because the same file name is
 * regenerated with different identities by later cases.
 */
export function traceConsoleBrv4(consolePage: ConsolePage): void {
  if (!EVIDENCE_ROOT_BRV4 || traces.has(consolePage)) return;
  const trace: ConsoleTrace = { uploads: [], downloads: [] };
  traces.set(consolePage, trace);
  let feedDate = '';
  let pending: UploadTrace | null = null;
  let openedRunId = '';

  const setFeedDate = consolePage.setFeedDate.bind(consolePage);
  consolePage.setFeedDate = async (d: string) => {
    await setFeedDate(d);
    feedDate = d;
  };
  const chooseFile = consolePage.chooseFile.bind(consolePage);
  consolePage.chooseFile = async (p: string) => {
    await chooseFile(p);
    pending = { sourcePath: p, feedDate, runId: '', chosenAt: new Date().toISOString(), content: fs.readFileSync(p) };
  };
  const submit = consolePage.submitAndGetRunId.bind(consolePage);
  consolePage.submitAndGetRunId = async () => {
    const upload = pending;
    pending = null;
    if (upload) trace.uploads.push(upload);
    const runId = await submit();
    if (upload) upload.runId = runId;
    return runId;
  };
  const openRun = consolePage.openRun.bind(consolePage);
  consolePage.openRun = async (runId: string) => {
    await openRun(runId);
    openedRunId = runId;
  };
  const download = consolePage.downloadAllArtifacts.bind(consolePage);
  consolePage.downloadAllArtifacts = async (p: string) => {
    const saved = await download(p);
    trace.downloads.push({ zipPath: saved, runId: openedRunId, savedAt: new Date().toISOString() });
    return saved;
  };
}

const rel = (p: string) => path.relative(path.join(__dirname, '..'), p).split(path.sep).join('/');
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

/** TC ids this test produces evidence for - the feed's own case list for an upload test, else the TC ids in its title. */
export function tcIdsForTestBrv4(testInfo: TestInfo): string[] {
  const ids = new Set<string>();
  const feed = testInfo.annotations.find((a) => a.type === 'feed')?.description;
  if (feed) {
    for (const id of loadFeedsBrv4().find((f) => f.file === feed)?.cases ?? []) ids.add(id);
    for (const id of (testInfo.annotations.find((a) => a.type === 'cases')?.description ?? '').match(/TC-BR-\d+/g) ?? []) ids.add(id);
  }
  if (!ids.size) for (const id of testInfo.title.match(/TC-BR-\d+/g) ?? []) ids.add(id);
  return [...ids];
}

function copyUnique(src: Buffer | string, dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const content = typeof src === 'string' ? fs.readFileSync(src) : src;
  let target = path.join(dir, name);
  for (let n = 2; fs.existsSync(target); n++) {
    if (fs.readFileSync(target).equals(content)) return target;
    const ext = path.extname(name);
    target = path.join(dir, `${path.basename(name, ext)}.${n}${ext}`);
  }
  fs.writeFileSync(target, content);
  return target;
}

/**
 * afterEach: copies this test's evidence into each of its TCs' folders under
 * this suite, writes a capture log, and attaches the copied files to the
 * test's report entry (navigation between suites lives in evidence-index.html). Never throws - a capture problem is
 * recorded in the capture log instead of changing the test's own result.
 */
export async function captureEvidenceBrv4(testInfo: TestInfo, suite: SuiteBrv4, consolePage?: ConsolePage): Promise<void> {
  if (!EVIDENCE_ROOT_BRV4) return;
  const tcIds = tcIdsForTestBrv4(testInfo);
  const trace = consolePage ? traces.get(consolePage) : undefined;
  const attempt = testInfo.retry;
  const feedAnnotation = testInfo.annotations.find((a) => a.type === 'feed')?.description ?? '';
  const slug = safeName(feedAnnotation || tcIds.join('_') || testInfo.title).slice(0, 120);
  const captureErrors: string[] = [];
  const toAttach: Array<{ name: string; path: string; contentType: string }> = [];

  for (const tc of tcIds) {
    const dir = tcEvidenceDirBrv4(suite, tc);
    const attemptDir = (sub: string) => path.join(dir, sub, ...(attempt > 0 ? [`attempt-${attempt}`] : []));
    const copied = { testData: [] as string[], generated: [] as string[], logs: [] as string[], result: '' };
    try {
      fs.mkdirSync(dir, { recursive: true });

      for (const u of trace?.uploads ?? []) {
        const p = copyUnique(u.content, attemptDir('test-data'), path.basename(u.sourcePath));
        copied.testData.push(p);
        if (tc === tcIds[0]) toAttach.push({ name: `test-data: ${path.basename(p)}`, path: p, contentType: 'text/plain' });
      }

      for (const d of trace?.downloads ?? []) {
        // Same folder name as under artifacts/e2e-brv4/runs/ (run-<TC>-<time>).
        const runDir = path.join(attemptDir('generated-files'), path.basename(path.dirname(d.zipPath)));
        if (fs.existsSync(d.zipPath)) {
          const zip = copyUnique(d.zipPath, runDir, path.basename(d.zipPath));
          copied.generated.push(zip);
          if (tc === tcIds[0]) toAttach.push({ name: `generated: ${path.basename(zip)}`, path: zip, contentType: 'application/zip' });
        } else captureErrors.push(`${tc}: downloaded ZIP no longer at ${rel(d.zipPath)}`);
        const extracted = path.join(path.dirname(d.zipPath), 'extracted');
        if (fs.existsSync(extracted) && !fs.existsSync(path.join(runDir, 'extracted'))) {
          fs.cpSync(extracted, path.join(runDir, 'extracted'), { recursive: true });
          copied.generated.push(path.join(runDir, 'extracted'));
        }
      }

      if (suite === 'e2e-execute-brv4' && feedAnnotation) {
        const safe = safeName(feedAnnotation);
        const runRecord = path.join(E2E_ROOT_BRV4, 'runs', `${safe}.json`);
        const consoleLog = path.join(E2E_ROOT_BRV4, 'console', `${safe}.log`);
        if (fs.existsSync(runRecord)) copied.logs.push(copyUnique(runRecord, attemptDir('logs'), `run-record-${safe}.json`));
        if (fs.existsSync(consoleLog)) copied.logs.push(copyUnique(consoleLog, attemptDir('logs'), `console-${safe}.log`));
      }

      if (suite !== 'e2e-execute-brv4') {
        // The shared verdict file as THIS suite left it - e2e-db-brv4 later
        // rewrites the same file, so it has to be taken now.
        const verdictFile = path.join(VERDICT_DIR_BRV4, `${tc}.json`);
        if (fs.existsSync(verdictFile)) {
          const v = JSON.parse(fs.readFileSync(verdictFile, 'utf8'));
          // Only this test writes its TC's verdict file inside this worker,
          // so a decidedAt before the worker loaded means a stale verdict.
          const fresh = Date.parse(v.decidedAt) >= WORKER_STARTED_AT;
          const name = suite === 'e2e-validate-brv4' ? 'validation-result.json' : 'db-verification-result.json';
          copied.result = path.join(attemptDir(''), name);
          fs.mkdirSync(path.dirname(copied.result), { recursive: true });
          fs.writeFileSync(copied.result, JSON.stringify({ ...v, _writtenByThisTest: fresh, _source: rel(verdictFile) }, null, 2));
          toAttach.push({ name: `${tc}: ${name}`, path: copied.result, contentType: 'application/json' });
        } else captureErrors.push(`${tc}: no verdict file at ${rel(verdictFile)}`);
      }

      const capture = {
        suite,
        tcId: tc,
        sharedWith: tcIds.filter((x) => x !== tc),
        testTitle: testInfo.title,
        testId: testInfo.testId,
        attempt,
        status: testInfo.status,
        expectedStatus: testInfo.expectedStatus,
        durationMs: testInfo.duration,
        capturedAt: new Date().toISOString(),
        feed: feedAnnotation || null,
        annotations: testInfo.annotations,
        errors: testInfo.errors.map((e) => stripAnsi(e.message ?? String(e.value ?? ''))),
        uploads: (trace?.uploads ?? []).map((u) => ({ feedFile: path.basename(u.sourcePath), sourcePath: rel(u.sourcePath), feedDate: u.feedDate, runId: u.runId, chosenAt: u.chosenAt })),
        downloads: (trace?.downloads ?? []).map((d) => ({ zip: rel(d.zipPath), runId: d.runId, savedAt: d.savedAt })),
        copied: {
          testData: copied.testData.map((p) => path.relative(dir, p).split(path.sep).join('/')),
          generatedFiles: copied.generated.map((p) => path.relative(dir, p).split(path.sep).join('/')),
          logs: copied.logs.map((p) => path.relative(dir, p).split(path.sep).join('/')),
          result: copied.result ? path.relative(dir, copied.result).split(path.sep).join('/') : null,
        },
        captureErrors: captureErrors.filter((e) => e.startsWith(`${tc}:`)),
      };
      fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'logs', `capture-${slug}.attempt-${attempt}.json`), JSON.stringify(capture, null, 2));
    } catch (e) {
      captureErrors.push(`${tc}: evidence capture failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    for (const a of toAttach) await testInfo.attach(a.name, { path: a.path, contentType: a.contentType });
    if (captureErrors.length) testInfo.annotations.push({ type: 'evidence-capture-errors', description: captureErrors.join(' | ') });
  } catch {
    // attaching is best-effort; the files are already in the evidence folder
  }
}
