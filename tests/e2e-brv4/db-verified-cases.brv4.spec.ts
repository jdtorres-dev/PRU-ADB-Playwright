import { test, expect } from '../../fixtures/console.fixture';
import { CASES, reserveSeqRange, snapshotUnprocessedActivity, releaseFailedHr2Leftovers } from '../../utils/db-verified-cases.brv4';
import { recordVerdictBrv4 } from '../../utils/verdict-store.brv4';

/**
 * Real, saved automation for the BRv4 DB-fixture test cases (33 rules whose
 * precondition or verification needs direct Postgres access, not just an
 * uploaded feed). Each case in utils/db-verified-cases.brv4.ts seeds its own
 * precondition (via a fresh feed upload and/or a scoped, FK-safe direct
 * write through utils/db.brv4.ts), runs a cycle through the live app the
 * same way every other test in this suite does, then verifies the result
 * directly in Postgres.
 *
 * Runs one case at a time, same as every other BRv4 spec - the target
 * environment has no data reset, so concurrent runs risk cross-contaminating
 * each other's identities.
 */

// Not 'serial' mode: in serial mode the first FAIL skips every remaining case, and
// known application defects fail here on every run. Cases still execute one
// at a time - the config pins workers: 1 and fullyParallel: false. After a
// failure Playwright restarts the worker, and beforeAll re-reads the highest
// committed seq, so identities stay unique.

test.describe('PRU ADB - BRv4 DB-verified cases', () => {
  // Start this run's identities above everything already committed - see
  // reserveSeqRange() in utils/db-verified-cases.brv4.ts.
  test.beforeAll(async () => {
    await reserveSeqRange();
  });

  for (const c of CASES) {
    test(`${c.tcId} ${c.rule}`, async ({ authenticatedConsole }) => {
      test.info().annotations.push({ type: 'rule', description: c.rule });
      let results: Awaited<ReturnType<typeof c.run>> = [];
      let error = '';
      // A failed HR2 must not leave this case's activity rows behind to fail
      // every later case on the same date - see releaseFailedHr2Leftovers.
      const unprocessedBefore = await snapshotUnprocessedActivity();
      try {
        results = await c.run(authenticatedConsole);
      } catch (e) {
        error = e instanceof Error ? e.stack || e.message : String(e);
      } finally {
        const released = await releaseFailedHr2Leftovers(unprocessedBefore);
        if (released.length) test.info().annotations.push({ type: 'hr2-leftovers-released', description: released.join('; ') });
      }

      const allPassed = error === '' && results.length > 0 && results.every((r) => r.pass);
      const notes = error
        ? `Automation error: ${error}`
        : results.filter((r) => !r.pass).map((r) => `${r.description}: ${r.detail}`).join(' | ') || 'All checks passed.';

      recordVerdictBrv4({
        testCaseId: c.tcId,
        rule: c.rule,
        topic: '',
        priority: '',
        feedFile: '',
        feedDate: '20260908',
        generation: 99,
        runId: '',
        runStatus: '',
        artifactZip: '',
        verificationRoute: 'Database-observable',
        automationEligibility: 'Eligible - assert on database state',
        expectedBusinessOutcome: '',
        expectedDataEffect: '',
        actualSummary: error ? 'Automation error' : `${results.filter((r) => r.pass).length}/${results.length} checks passed`,
        checkResults: results.map((r) => ({ description: r.description, passed: r.pass, detail: r.detail })),
        verdict: allPassed ? 'PASS' : 'FAIL',
        notes,
        dbVerificationRequired: false,
        dbVerificationNotes: '',
      });

      test.info().annotations.push({ type: 'verdict', description: allPassed ? 'PASS' : 'FAIL' });
      if (error) throw new Error(error);
      expect(allPassed, notes).toBeTruthy();
    });
  }
});
