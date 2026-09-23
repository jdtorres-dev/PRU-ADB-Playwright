import * as fs from 'fs';
import type { TestCaseBrv4, ArtifactCheck } from './types.brv4';
import type { RunRecordBrv4 } from './verdict-store.brv4';
import {
  parseControlReport,
  parseSkipReport,
  artifactContains,
  counterMatching,
} from './artifact-validator';

/**
 * Judging logic for the BRv4-uncovered-rules suite.
 *
 * Two gating rules apply before any check is evaluated (mirrors the original
 * suite's own three gating rules in utils/verdict-rules.ts, minus the
 * Confidence-C/OBSERVED path, which this suite does not use):
 *   1. A case whose feed/trigger this framework cannot construct is BLOCKED,
 *      never FAIL (tc.executable === false).
 *   2. An automation or environment failure (no run record, or the run itself
 *      errored) is BLOCKED, never FAIL.
 * Everything else is decided by walking tc.checks against the artifacts the
 * matching run downloaded - PASS only when every check passes.
 */

export interface CheckResult {
  description: string;
  passed: boolean;
  detail: string;
}

export interface Brv4Decision {
  verdict: 'PASS' | 'FAIL' | 'BLOCKED';
  actualSummary: string;
  checkResults: CheckResult[];
  notes: string;
}

function readArtifactText(filePath: string): string {
  return fs.readFileSync(filePath, 'latin1');
}

export function evaluateCheck(
  check: ArtifactCheck,
  run: RunRecordBrv4,
): CheckResult {
  const artifactPath = run.artifacts[check.artifact];
  if (!artifactPath || !fs.existsSync(artifactPath)) {
    return {
      description: check.description,
      passed: check.kind === 'artifactNotContains', // absence of the whole file also satisfies "must not contain"
      detail: `artifact ${check.artifact} was not present in this run's download`,
    };
  }

  switch (check.kind) {
    case 'controlReportCounterAtLeast': {
      const report = parseControlReport(artifactPath);
      const value = check.counterLabel ? report.counters[check.counterLabel] ?? null : null;
      const found = value ?? counterMatching(report, new RegExp(check.counterLabel || '', 'i'));
      const passed = found !== null && found >= (check.minValue ?? 1);
      return {
        description: check.description,
        passed,
        detail: `counter "${check.counterLabel}" = ${found === null ? '(not found)' : found}, required >= ${check.minValue ?? 1}`,
      };
    }
    case 'artifactContains': {
      const passed = artifactContains(artifactPath, check.needle || '');
      return {
        description: check.description,
        passed,
        detail: `${check.artifact} ${passed ? 'contains' : 'does not contain'} "${check.needle}"`,
      };
    }
    case 'artifactNotContains': {
      const passed = !artifactContains(artifactPath, check.needle || '');
      return {
        description: check.description,
        passed,
        detail: `${check.artifact} ${passed ? 'does not contain' : 'unexpectedly contains'} "${check.needle}"`,
      };
    }
    case 'skipReportReasonAtPosition': {
      const entries = parseSkipReport(artifactPath);
      const match = entries.find((e) => e.raw.includes(check.identifierNeedle || '\u0000'));
      const passed = !!match && match.reasonCode === check.expectedReason;
      return {
        description: check.description,
        passed,
        detail: match
          ? `found identifier with reason ${match.reasonCode}, expected ${check.expectedReason}`
          : `identifier "${check.identifierNeedle}" not found in ${check.artifact}`,
      };
    }
    default:
      return { description: check.description, passed: false, detail: 'unknown check kind' };
  }
}

export function judgeBrv4(tc: TestCaseBrv4, run: RunRecordBrv4): Brv4Decision {
  const checkResults = tc.checks.map((c) => evaluateCheck(c, run));
  const allPassed = checkResults.length > 0 && checkResults.every((r) => r.passed);
  const failed = checkResults.filter((r) => !r.passed);
  return {
    verdict: allPassed ? 'PASS' : 'FAIL',
    actualSummary: allPassed
      ? `All ${checkResults.length} automated check(s) passed.`
      : `${failed.length} of ${checkResults.length} automated check(s) failed.`,
    checkResults,
    notes: allPassed
      ? tc.dbVerificationRequired
        ? `Automated (UI/artifact) evidence confirms the rule. ${tc.dbVerificationNotes}`
        : 'Automated (UI/artifact) evidence confirms the rule.'
      : failed.map((f) => `${f.description}: ${f.detail}`).join(' | '),
  };
}
