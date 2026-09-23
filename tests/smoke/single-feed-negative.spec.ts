import { test, expect } from '../../fixtures/console.fixture';
import * as fs from 'fs';
import * as path from 'path';
import { extractArtifacts, locateArtifacts, parseLnaReport } from '../../utils/artifact-validator';
import { loadTestCases, feedAbsolutePath } from '../../utils/registry';
import { judgeNegative } from '../../utils/verdict-rules';
import { E2E_ROOT } from '../../utils/verdict-store';

/**
 * Smoke test: one representative negative case, executed and validated
 * end-to-end (login -> set date -> upload -> wait -> download -> extract ->
 * validate -> verdict), the same architecture the full 85-feed suite uses.
 *
 * TC-BR-018 / ALLSTATE.LNA.B0607.D20260908.txt is chosen deliberately: its
 * bundle is rejected before commit (see Evidence/runs - 0 committed, 2 rolled
 * back), so re-uploading it never presents an identifier ADB has already
 * committed. It is safe to run against any generation, unlike a positive
 * case, which commits state and therefore requires a freshly reissued
 * generation to mean anything on a second run (README.md > "No data reset").
 */
const FEED_DATE = process.env.FEED_DATE || '20260908';
const CASE_ID = 'TC-BR-018';

test(`${CASE_ID}: negative case is refused with its expected code`, async ({ authenticatedConsole }) => {
  const tc = loadTestCases().find((c) => c.id === CASE_ID);
  if (!tc) throw new Error(`${CASE_ID} not found in data/test-cases.json`);
  const target = tc.feeds[0];
  const feedPath = feedAbsolutePath({
    file: target.feed,
    path: '',
    family: '',
    code: '',
    destination: '',
    phase: 1,
    records: 0,
    bundles: 0,
    cases: [],
  });
  expect(fs.existsSync(feedPath), `feed file missing: ${feedPath}`).toBeTruthy();

  await authenticatedConsole.setFeedDate(FEED_DATE);
  await authenticatedConsole.chooseFile(feedPath);
  const runId = await authenticatedConsole.submitAndGetRunId();
  const runPayload = await authenticatedConsole.waitForRunToSettle(runId);

  await authenticatedConsole.openRun(runId);
  const zipPath = path.join(E2E_ROOT, 'runs', `run-${runId}`, `ingestion-artifacts-${runId}.zip`);
  await authenticatedConsole.downloadAllArtifacts(zipPath);
  expect(fs.statSync(zipPath).size).toBeGreaterThan(0);

  const extractedDir = path.join(E2E_ROOT, 'runs', `run-${runId}`, 'extracted');
  extractArtifacts(zipPath, extractedDir);
  const artifacts = locateArtifacts(extractedDir);
  expect(artifacts.LNAERROR, 'the ZIP must contain an LNA report').toBeTruthy();

  const refusals = parseLnaReport(artifacts.LNAERROR!);
  const decision = judgeNegative(
    tc,
    {
      feedFile: target.feed,
      feedPath,
      feedDate: FEED_DATE,
      generation: null,
      runId,
      runStatus: String(runPayload?.status ?? 'UNKNOWN'),
      zipPath,
      extractedDir,
      artifacts: artifacts as Record<string, string>,
      uploadedAt: new Date().toISOString(),
    },
    refusals,
  );

  test.info().annotations.push(
    { type: 'verdict', description: decision.verdict },
    { type: 'actualCode', description: decision.actualCode },
    { type: 'notes', description: decision.notes },
  );

  expect(
    decision.verdict,
    `${tc.id} (${tc.rule}): expected ${tc.expectedCode}, got ${decision.actualCode}. ${decision.notes}`,
  ).toBe('PASS');
});
