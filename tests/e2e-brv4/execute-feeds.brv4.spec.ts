import { test, expect } from '../../fixtures/console.fixture';
import * as fs from 'fs';
import * as path from 'path';
import { extractArtifacts, locateArtifacts } from '../../utils/artifact-validator';
import { loadFeedsBrv4, loadGenerationBrv4, feedAbsolutePathBrv4, casesForFeedBrv4, loadTestCasesBrv4 } from '../../utils/registry.brv4';
import { recordRunBrv4, E2E_ROOT_BRV4 } from '../../utils/verdict-store.brv4';
import { summariseLogs } from '../../utils/verdict-store';

/**
 * Execution phase for the isolated BRv4-uncovered-rules suite (189 new test
 * cases, 12 of them feed-drivable - see data/test-cases.brv4.json). Same
 * two-phase design as tests/e2e/execute-feeds.spec.ts: this uploads every
 * feed in data/feeds.brv4.json and records what came back under
 * artifacts/e2e-brv4/runs/. It never judges pass/fail - that happens in
 * tests/validation-brv4, which touches the application not at all.
 *
 * Fully isolated from the original suite: separate feed files (data/feeds/
 * ALLSTATE.LNA.BR-<n>*.txt), separate registries (data/*.brv4.json), separate
 * run/verdict directories (artifacts/e2e-brv4/), separate identity space
 * (generation 99 - see data/generation.brv4.json). Running this can never
 * read, write, or collide with anything the original 85-feed suite produces.
 *
 * Run only after the fixed-width feed files exist (scripts/make-feeds-brv4.js
 * already wrote them into data/feeds/ - nothing to reissue here, since these
 * identifiers are permanent and reserved to generation 99).
 */

const FEED_DATE = process.env.BRV4_FEED_DATE || '20260908';

// data/feeds.brv4.json is already in dependency order: a rule's "setup" feed
// (phase 0) appears before its own "test"/"single" feed (phase 1). Do not re-sort.
const feeds = loadFeedsBrv4();
const cases = loadTestCasesBrv4();
const generation = loadGenerationBrv4();

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  fs.mkdirSync(E2E_ROOT_BRV4, { recursive: true });
  // eslint-disable-next-line no-console
  console.log(
    `\nBRv4 E2E execution - generation ${generation ? generation.generation : '(none)'}\n` +
      `${feeds.length} feed files, ${cases.filter((c) => c.executable).length} executable test cases, feed date ${FEED_DATE}\n`,
  );
});

for (const feed of feeds) {
  const linked = casesForFeedBrv4(cases, feed.file);

  const label = feed.role === 'setup'
    ? `upload ${feed.file}  (setup - commits state for its own test feed)`
    : `upload ${feed.file}  (${feed.bundles} bundle(s), ${linked.map((c) => c.id).join(', ')})`;

  test(label, async ({ authenticatedConsole }) => {
    test.info().annotations.push(
      { type: 'feed', description: feed.file },
      { type: 'role', description: feed.role },
      { type: 'cases', description: linked.map((c) => c.id).join(', ') },
    );

    const feedPath = feedAbsolutePathBrv4(feed);
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
        zipPath = path.join(E2E_ROOT_BRV4, 'runs', `run-${runId}`, `ingestion-artifacts-${runId}.zip`);
        await authenticatedConsole.downloadAllArtifacts(zipPath);
        expect(fs.existsSync(zipPath), 'the artifacts ZIP must be saved').toBeTruthy();
        expect(fs.statSync(zipPath).size, 'the artifacts ZIP must not be empty').toBeGreaterThan(0);
      });

      await test.step('extract the artifacts', async () => {
        extractedDir = path.join(E2E_ROOT_BRV4, 'runs', `run-${runId}`, 'extracted');
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
      failure = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      recordRunBrv4({
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
        const dir = path.join(E2E_ROOT_BRV4, 'console');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, `${feed.file.replace(/[^A-Za-z0-9._-]/g, '_')}.log`),
          logLines.join('\n') + '\n',
        );
      }
    }
  });
}
