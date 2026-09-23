import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import {
  parseLnaReport,
  parseControlReport,
  parseSkipReport,
  refusalsInRange,
  LnaRefusal,
  ControlReport,
  SkipEntry,
} from '../../utils/artifact-validator';
import { loadTestCases } from '../../utils/registry';
import { TestCase } from '../../utils/types';
import { recordVerdict, readRun, RunRecord } from '../../utils/verdict-store';
import {
  judgeNegative,
  judgePositive,
  judgeControlsSatisfied,
  judgeHeaderControl,
  judgeDestination,
} from '../../utils/verdict-rules';

/**
 * Validation phase.
 *
 * Reads only what tests/e2e already downloaded. Nothing here touches the
 * application, so it can be re-run as often as needed without consuming
 * identifiers - see README.md > "Verdict rules" for the three rules applied
 * below, in order, before any BRD judging happens.
 */

const cases = loadTestCases();

/** Parsed artifacts, cached per run so 284 cases do not re-read the same files. */
const lnaCache = new Map<string, LnaRefusal[]>();
const cntlCache = new Map<string, ControlReport | null>();
const skipCache = new Map<string, SkipEntry[]>();

function lnaFor(run: RunRecord): LnaRefusal[] {
  const p = run.artifacts?.LNAERROR;
  if (!p) return [];
  if (!lnaCache.has(p)) lnaCache.set(p, fs.existsSync(p) ? parseLnaReport(p) : []);
  return lnaCache.get(p)!;
}

function skipFor(run: RunRecord): SkipEntry[] {
  const p = run.artifacts?.ADBSKIP;
  if (!p) return [];
  if (!skipCache.has(p)) skipCache.set(p, fs.existsSync(p) ? parseSkipReport(p) : []);
  return skipCache.get(p)!;
}

function cntlFor(run: RunRecord): ControlReport | null {
  const p = run.artifacts?.CNTLRPT;
  if (!p) return null;
  if (!cntlCache.has(p)) cntlCache.set(p, fs.existsSync(p) ? parseControlReport(p) : null);
  return cntlCache.get(p)!;
}

function judge(tc: TestCase, run: RunRecord) {
  if (tc.type === 'Positive') {
    return judgePositive(tc, run, lnaFor(run), cntlFor);
  }
  if (tc.destinationArtifact === 'CNTLRPT' && !tc.expectedCode && tc.conditionForced) {
    // A header control either fails and stops the run, or is reported satisfied.
    const byDesignValid = tc.feeds.some((f) => f.feed === run.feedFile && f.cls === 'positive');
    return byDesignValid
      ? judgeControlsSatisfied(tc, run, cntlFor(run))
      : judgeHeaderControl(tc, run, cntlFor(run));
  }
  if (tc.expectedCode && tc.destinationArtifact === 'LNAERROR' && tc.conditionForced) {
    // The feed forces the condition and a specific code is named: the exact
    // code must appear, not merely "some refusal". See judgeNegative's docs -
    // a different code firing first masks the rule under test and is a FAIL,
    // per section 12 of the automation brief. tc.conditionForced === false is
    // deliberately excluded here: those cases (mostly Interaction-type) test
    // that the condition does NOT fire, so judgeDestination's "record is
    // valid" branch - no refusal, applied to the load output - is correct for
    // them, not this strict code match.
    return judgeNegative(tc, run, lnaFor(run));
  }
  // The BRD's own test: did the output land at the assigned destination?
  return judgeDestination(tc, run, lnaFor(run), skipFor(run), cntlFor(run));
}

test.describe('PRU ADB - validation (BRD v4)', () => {
  for (const tc of cases) {
    const title = `${tc.id}  ${tc.rule}  ${tc.expectedCode || tc.expectedDestination || '(no code)'}`;

    test(title, async () => {
      test.info().annotations.push(
        { type: 'rule', description: tc.rule },
        { type: 'priority', description: tc.priority },
        { type: 'topic', description: tc.topic },
      );

      const feedFile = tc.feeds[0]?.feed ?? '';
      const run = feedFile ? readRun(feedFile) : null;
      const positions = tc.feeds.map((f) => `${f.feed} rec ${f.recordStart}-${f.recordEnd}`).join('; ');

      const base = {
        testCaseId: tc.id,
        rule: tc.rule,
        topic: tc.topic,
        priority: tc.priority,
        feedFile,
        feedDate: run?.feedDate ?? '',
        generation: run?.generation ?? null,
        runId: run?.runId ?? '',
        runStatus: run?.runStatus ?? '',
        artifactZip: run?.zipPath ?? '',
        recordPositions: positions,
        expectedCode: tc.expectedCode,
        expectedDescription: tc.expectedDescription,
        expectedDestination: tc.expectedDestination,
      };

      // --- rule 1: Confidence C is observed, never judged -------------------
      if (tc.bcr) {
        const refusals = run ? lnaFor(run) : [];
        const seen = tc.feeds.flatMap((f) =>
          f.feed === run?.feedFile ? refusalsInRange(refusals, f.recordStart, f.recordEnd) : [],
        );
        recordVerdict({
          ...base,
          actualCode: seen.map((s) => s.errorCode).join(', ') || '(none)',
          actualDescription: seen[0]?.errorDescription ?? '(none)',
          actualDestination: seen.length ? 'LNAERROR' : '(none)',
          verdict: 'OBSERVED',
          notes:
            'BUSINESS CONFIRMATION REQUIRED. BRD v4 marks this rule Confidence C, so no expected ' +
            'result can be stated. Behaviour is recorded, not judged. QA Test Plan v1.00 S6.3.',
        });
        test.info().annotations.push({ type: 'verdict', description: 'OBSERVED' });
        return;
      }

      // --- rule 2: condition not forced by the file --------------------------
      if (!tc.executable) {
        recordVerdict({
          ...base,
          actualCode: '(not executed)',
          actualDescription: '',
          actualDestination: '',
          verdict: 'BLOCKED',
          notes: tc.blockedReason,
        });
        test.info().annotations.push({ type: 'verdict', description: 'BLOCKED' });
        test.skip(true, tc.blockedReason);
        return;
      }

      // --- rule 3: the feed never ran, or hit an automation/environment failure
      if (!run) {
        recordVerdict({
          ...base,
          actualCode: '(not executed)',
          actualDescription: '',
          actualDestination: '',
          verdict: 'BLOCKED',
          notes: `No run record for ${feedFile}. Run the e2e-execute project first.`,
        });
        test.skip(true, `no run record for ${feedFile}`);
        return;
      }
      if (run.error) {
        recordVerdict({
          ...base,
          actualCode: '(not executed)',
          actualDescription: '',
          actualDestination: '',
          verdict: 'BLOCKED',
          notes:
            `The upload of ${feedFile} did not complete: ${run.error} ` +
            'This is an automation or environment failure, not a failure of the application.',
        });
        test.skip(true, `upload failed for ${feedFile}`);
        return;
      }

      // --- judge ---------------------------------------------------------
      const decision = judge(tc, run);
      const v = recordVerdict({ ...base, ...decision });
      test.info().annotations.push(
        { type: 'verdict', description: v.verdict },
        { type: 'actualCode', description: v.actualCode },
      );

      // The assertion is what turns a FAIL into a red test. The verdict file
      // is already on disk either way, so a failure here cannot lose the record.
      expect(
        v.verdict,
        `${tc.id} (${tc.rule}): expected ${tc.expectedCode || tc.expectedDestination}, ` +
          `got ${v.actualCode}. ${v.notes}`,
      ).toBe('PASS');
    });
  }
});
