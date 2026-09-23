import { test, expect } from '../../fixtures/console.fixture';
import * as fs from 'fs';
import * as path from 'path';
import { extractArtifacts, locateArtifacts } from '../../utils/artifact-validator';
import { loadFeeds, loadGeneration, loadTestCases, casesForFeed, feedAbsolutePath } from '../../utils/registry';
import { recordRun, summariseLogs, E2E_ROOT } from '../../utils/verdict-store';

/**
 * Execution phase - uploads every feed file in data/feeds.json and records
 * what came back. No verdict is decided here; judging happens in
 * tests/validation, which touches the application not at all and can
 * therefore be re-run freely without consuming any more identifiers.
 *
 * One test per feed file: log in, set the feed date, upload, wait for the run
 * to settle, download the General Artifacts ZIP, extract it, record the run.
 *
 * Before running this against an environment that has already seen these
 * feeds, issue a fresh generation:
 *     python scripts/reissue_e2e.py <n>
 * The environment has no data reset. A bundle whose firm record passes
 * validation commits its organisation, so presenting the same identifiers
 * again raises B0700 instead of the condition under test.
 */

const FEED_DATE = process.env.FEED_DATE || '20260908'; // carried on every file's submitting header

// feeds.json is already in upload order: phase 0 (setup files that commit
// state) before phase 1 (the files that depend on it). Do not re-sort.
const feeds = loadFeeds();
const cases = loadTestCases();
const generation = loadGeneration();

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (!generation) {
    throw new Error(
      'data/generation.json is missing, so the feed files carry no generation stamp.\n' +
        'Run:  python scripts/reissue_e2e.py <generation>\n' +
        'Uploading un-reissued feeds into an environment that has already seen them ' +
        'raises B0700 on every committed bundle and invalidates the whole run.',
    );
  }
  fs.mkdirSync(E2E_ROOT, { recursive: true });
  // eslint-disable-next-line no-console
  console.log(
    `\nE2E execution - generation ${generation.generation}, issued ${generation.issuedAt}\n` +
      `${feeds.length} feed files, ${cases.length} test cases, feed date ${FEED_DATE}\n`,
  );
});

for (const feed of feeds) {
  const linked = casesForFeed(cases, feed.file);
  const executable = linked.filter((c) => c.executable).length;

  const label = feed.family === 'setup'
    ? `upload ${feed.file}  (setup - commits state for a later file)`
    : `upload ${feed.file}  (${feed.bundles} bundles, ${linked.length} cases, ${executable} executable)`;

  test(label, async ({ authenticatedConsole }) => {
    test.info().annotations.push(
      { type: 'feed', description: feed.file },
      { type: 'family', description: feed.family },
      { type: 'cases', description: linked.map((c) => c.id).join(', ') },
    );

    const feedPath = feedAbsolutePath(feed);
    let runId = '';
    let runStatus = 'NOT_STARTED';
    let zipPath = '';
    let extractedDir = '';
    let artifacts: Record<string, string> = {};
    let logLines: string[] = [];
    let failure = '';

    try {
      expect(fs.existsSync(feedPath), `feed file missing: ${feedPath}`).toBeTruthy();

      await test.step(`set the feed date to ${FEED_DATE}`, async () => {
        await authenticatedConsole.setFeedDate(FEED_DATE);
      });

      await test.step('select the feed file', async () => {
        await authenticatedConsole.chooseFile(feedPath);
      });

      await test.step('submit the upload', async () => {
        runId = await authenticatedConsole.submitAndGetRunId();
        expect(runId).toBeTruthy();
        test.info().annotations.push({ type: 'runId', description: runId });
      });

      await test.step('wait for processing to finish', async () => {
        const run = await authenticatedConsole.waitForRunToSettle(runId);
        runStatus = String(run?.status ?? 'UNKNOWN');
        logLines = authenticatedConsole.getCollectedLogs();
        const o = summariseLogs(logLines);
        test.info().annotations.push(
          { type: 'runStatus', description: runStatus },
          {
            type: 'console',
            description: `${o.committed} committed, ${o.rolledBack} rolled back, ${o.skipped} skipped`
              + (o.warnings.length ? ` - ${o.warnings.length} warning(s)` : ''),
          },
        );
      });

      await test.step('download the General Artifacts ALL (.zip)', async () => {
        await authenticatedConsole.openRun(runId);
        zipPath = path.join(E2E_ROOT, 'runs', `run-${runId}`, `ingestion-artifacts-${runId}.zip`);
        await authenticatedConsole.downloadAllArtifacts(zipPath);
        expect(fs.existsSync(zipPath), 'the artifacts ZIP must be saved').toBeTruthy();
        expect(fs.statSync(zipPath).size, 'the artifacts ZIP must not be empty').toBeGreaterThan(0);
      });

      await test.step('extract the artifacts', async () => {
        extractedDir = path.join(E2E_ROOT, 'runs', `run-${runId}`, 'extracted');
        extractArtifacts(zipPath, extractedDir);
        artifacts = locateArtifacts(extractedDir) as Record<string, string>;
        test.info().annotations.push({
          type: 'artifacts',
          description: Object.keys(artifacts).join(', ') || '(none found)',
        });
        expect(
          artifacts.LNAERROR || artifacts.CNTLRPT,
          'the ZIP must contain at least an LNA report or a control report',
        ).toBeTruthy();
      });
    } catch (e) {
      // Recorded, then re-thrown. The validation phase reads this and marks
      // the affected cases BLOCKED - an automation or environment failure
      // must never be written up as a failure of the application.
      failure = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      recordRun({
        feedFile: feed.file,
        feedPath,
        feedDate: FEED_DATE,
        generation: generation ? generation.generation : null,
        runId,
        runStatus,
        zipPath,
        extractedDir,
        artifacts,
        logLines,
        outcome: summariseLogs(logLines),
        ...(failure ? { error: failure } : {}),
      });
      if (logLines.length) {
        const dir = path.join(E2E_ROOT, 'console');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, `${feed.file.replace(/[^A-Za-z0-9._-]/g, '_')}.log`),
          logLines.join('\n') + '\n',
        );
      }
    }
  });
}
