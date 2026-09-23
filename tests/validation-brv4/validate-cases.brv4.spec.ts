import { test, expect } from '@playwright/test';
import { loadTestCasesBrv4 } from '../../utils/registry.brv4';
import { readRunBrv4, recordVerdictBrv4 } from '../../utils/verdict-store.brv4';
import { judgeBrv4 } from '../../utils/verdict-rules.brv4';
import type { TestCaseBrv4 } from '../../utils/types.brv4';

/**
 * Validation phase for the isolated BRv4-uncovered-rules suite. Reads only
 * what tests/e2e-brv4 already downloaded (artifacts/e2e-brv4/runs/) - nothing
 * here touches the application, so it can be re-run as often as needed.
 *
 * Two gating rules, applied before any check is evaluated, mirror the
 * original suite's own convention (utils/verdict-rules.ts):
 *   1. A case this framework cannot feed-drive at all (executable === false)
 *      is BLOCKED, never FAIL - see its blockedReason for why (most commonly:
 *      the rule's precondition can only be created via direct DB access,
 *      which this framework does not have).
 *   2. An automation/environment failure (no run record, or the run itself
 *      errored) is BLOCKED, never FAIL.
 * Everything else is decided by judgeBrv4() walking the case's declared
 * checks[] against the artifacts its run actually produced.
 */

const cases = loadTestCasesBrv4();

function assertionFeed(tc: TestCaseBrv4) {
  return tc.feeds.find((f) => f.cls === 'assertion target') ?? tc.feeds[tc.feeds.length - 1];
}

test.describe('PRU ADB - BRv4 uncovered-rules validation', () => {
  for (const tc of cases) {
    const title = `${tc.id}  ${tc.rule}  ${tc.verificationRoute}`;

    test(title, async () => {
      test.info().annotations.push(
        { type: 'rule', description: tc.rule },
        { type: 'priority', description: tc.priority },
        { type: 'topic', description: tc.topic },
        { type: 'verificationRoute', description: tc.verificationRoute },
      );

      const feed = assertionFeed(tc);
      const feedFile = feed?.feed ?? '';

      const base = {
        testCaseId: tc.id,
        rule: tc.rule,
        topic: tc.topic,
        priority: tc.priority,
        feedFile,
        feedDate: '',
        generation: null as number | null,
        runId: '',
        runStatus: '',
        artifactZip: '',
        verificationRoute: tc.verificationRoute,
        automationEligibility: tc.automationEligibility,
        expectedBusinessOutcome: tc.expectedBusinessOutcome,
        expectedDataEffect: tc.expectedDataEffect,
        dbVerificationRequired: tc.dbVerificationRequired,
        dbVerificationNotes: tc.dbVerificationNotes,
      };

      if (!tc.executable) {
        recordVerdictBrv4({
          ...base,
          actualSummary: '(not executed)',
          checkResults: [],
          verdict: 'BLOCKED',
          notes: tc.blockedReason,
        });
        test.info().annotations.push({ type: 'verdict', description: 'BLOCKED' });
        test.skip(true, tc.blockedReason);
        return;
      }

      const run = feedFile ? readRunBrv4(feedFile) : null;

      if (!run) {
        recordVerdictBrv4({
          ...base,
          actualSummary: '(not executed)',
          checkResults: [],
          verdict: 'BLOCKED',
          notes: `No run record for ${feedFile}. Run --project=e2e-execute-brv4 first.`,
        });
        test.skip(true, `no run record for ${feedFile}`);
        return;
      }

      if (run.error) {
        recordVerdictBrv4({
          ...base,
          runId: run.runId,
          runStatus: run.runStatus,
          feedDate: run.feedDate,
          generation: run.generation,
          actualSummary: '(not executed)',
          checkResults: [],
          verdict: 'BLOCKED',
          notes:
            `The upload of ${feedFile} did not complete: ${run.error} ` +
            'This is an automation or environment failure, not a failure of the application.',
        });
        test.skip(true, `upload failed for ${feedFile}`);
        return;
      }

      const decision = judgeBrv4(tc, run);
      const v = recordVerdictBrv4({
        ...base,
        runId: run.runId,
        runStatus: run.runStatus,
        feedDate: run.feedDate,
        generation: run.generation,
        artifactZip: run.zipPath,
        actualSummary: decision.actualSummary,
        checkResults: decision.checkResults,
        verdict: decision.verdict,
        notes: decision.notes,
      });

      test.info().annotations.push({ type: 'verdict', description: v.verdict });
      expect(v.verdict, `${tc.id}: ${v.notes}`).toBe('PASS');
    });
  }
});
