import * as fs from 'fs';
import {
  LnaRefusal,
  ControlReport,
  SkipEntry,
  refusalsInRange,
  skipsInRange,
  headerControlFailed,
  artifactContains,
} from './artifact-validator';
import { TestCase } from './types';
import { RunRecord, VerdictValue } from './verdict-store';

/**
 * Verdict rules (BRD v4 / README.md > "Verdict rules").
 *
 * Kept out of the test files on purpose: a spec file should read as a
 * business scenario (load the case, load its run, judge it, assert), not
 * carry the judging logic inline. This module has no Playwright dependency
 * and no side effects - it only reads what tests/e2e already downloaded.
 *
 * Three rules govern every verdict, applied before any of the functions below
 * are reached (see tests/validation):
 *   1. A Confidence C rule is OBSERVED, never Pass or Fail (QA Test Plan v1.00 S6.3).
 *   2. A case whose condition the feed does not force is BLOCKED, never FAIL.
 *   3. An automation or environment failure is BLOCKED, never FAIL.
 */

export interface Decision {
  verdict: VerdictValue;
  actualCode: string;
  actualDescription: string;
  actualDestination: string;
  notes: string;
}

/** A negative case: the named error code must be raised against this bundle. */
export function judgeNegative(tc: TestCase, run: RunRecord, refusals: LnaRefusal[]): Decision {
  const hits: LnaRefusal[] = [];
  for (const f of tc.feeds) {
    if (f.feed !== run.feedFile) continue;
    hits.push(...refusalsInRange(refusals, f.recordStart, f.recordEnd));
  }

  if (hits.length === 0) {
    return {
      verdict: 'FAIL',
      actualCode: '(none)',
      actualDescription: '(no refusal raised against this bundle)',
      actualDestination: run.artifacts?.LNAERROR ? 'LNAERROR (bundle absent)' : '(no LNA report)',
      notes:
        `Expected ${tc.expectedCode} at records ` +
        tc.feeds
          .filter((f) => f.feed === run.feedFile)
          .map((f) => `${f.recordStart}-${f.recordEnd}`)
          .join(', ') +
        '. The LNA report carries no refusal for those records.',
    };
  }

  const match = hits.find((h) => h.errorCode === tc.expectedCode);
  if (match) {
    const sameText =
      !tc.expectedDescription ||
      match.errorDescription.trim().toUpperCase() === tc.expectedDescription.trim().toUpperCase();
    return {
      verdict: 'PASS',
      actualCode: match.errorCode,
      actualDescription: match.errorDescription,
      actualDestination: 'LNAERROR',
      notes: sameText
        ? `Refused at record ${match.recordPosition} with the expected code and description.`
        : `Refused at record ${match.recordPosition} with the expected code. The description ` +
          `differs from the reference: expected "${tc.expectedDescription}".`,
    };
  }

  const other = hits[0];
  return {
    verdict: 'FAIL',
    actualCode: hits.map((h) => h.errorCode).join(', '),
    actualDescription: other.errorDescription,
    actualDestination: 'LNAERROR',
    notes:
      `Expected ${tc.expectedCode}. The bundle was refused with ` +
      `${hits.map((h) => `${h.errorCode} at record ${h.recordPosition}`).join(', ')}. ` +
      'A different refusal firing first can mask the rule under test - check the record ' +
      'before treating this as a defect.',
  };
}

/** A positive case: no refusal for this bundle, and the work actually landed. */
export function judgePositive(
  tc: TestCase,
  run: RunRecord,
  refusals: LnaRefusal[],
  cntlFor: (run: RunRecord) => ControlReport | null,
): Decision {
  const hits: LnaRefusal[] = [];
  for (const f of tc.feeds) {
    if (f.feed !== run.feedFile) continue;
    hits.push(...refusalsInRange(refusals, f.recordStart, f.recordEnd));
  }

  if (hits.length > 0) {
    return {
      verdict: 'FAIL',
      actualCode: hits.map((h) => h.errorCode).join(', '),
      actualDescription: hits[0].errorDescription,
      actualDestination: 'LNAERROR',
      notes: 'A valid bundle was refused. Expected it to be accepted and applied.',
    };
  }

  // Absence of a refusal is necessary but not sufficient. Confirm the bundle
  // reached the load output.
  const bd = tc.feeds.find((f) => f.feed === run.feedFile)?.bd ?? '';
  const loadFile = run.artifacts?.LOADFILE;
  if (bd && loadFile && fs.existsSync(loadFile)) {
    const present = artifactContains(loadFile, bd);
    return {
      verdict: present ? 'PASS' : 'FAIL',
      actualCode: '(none)',
      actualDescription: '(no refusal)',
      actualDestination: present ? 'LOADFILE' : '(not in the load output)',
      notes: present
        ? `No refusal, and identifier ${bd} is present in the load output.`
        : `No refusal was raised, but identifier ${bd} is absent from the load output. ` +
          'The bundle was neither refused nor applied.',
    };
  }

  const cntl = cntlFor(run);
  return {
    verdict: cntl ? 'PASS' : 'BLOCKED',
    actualCode: '(none)',
    actualDescription: '(no refusal)',
    actualDestination: cntl ? 'CNTLRPT' : '(no artifact to confirm against)',
    notes: cntl
      ? 'No refusal was raised against this bundle and the run produced a control report. ' +
        'The load output could not be checked for this case, so acceptance is inferred from ' +
        'the absence of a refusal only.'
      : 'No refusal, but neither the load output nor the control report is available to ' +
        'confirm the bundle was applied.',
  };
}

/**
 * A case whose outcome is a skip-report entry. The LNA report is the wrong place
 * to look: the Java writes a SkippedRecordEntry and no LNAERROR row.
 */
export function judgeSkip(tc: TestCase, run: RunRecord, entries: SkipEntry[]): Decision {
  const hits = tc.feeds
    .filter((f) => f.feed === run.feedFile)
    .flatMap((f) => skipsInRange(entries, f.recordStart, f.recordEnd));

  const wanted = /002|EARLIER_BUNDLE/.test(tc.expectedDestination + ' ' + tc.id) ? '002' : '';
  if (hits.length === 0) {
    return {
      verdict: 'FAIL',
      actualCode: '(none)',
      actualDescription: '(no skip entry for these records)',
      actualDestination: run.artifacts?.ADBSKIP ? 'ADBSKIP (records absent)' : '(no skip report)',
      notes:
        'Expected an entry on the skip report for records ' +
        tc.feeds.filter((f) => f.feed === run.feedFile)
          .map((f) => `${f.recordStart}-${f.recordEnd}`).join(', ') +
        '. The skip report carries none. Check whether the record was refused to the LNA report ' +
        'instead, which would mean the routing differs from the rule.',
    };
  }
  const codes = Array.from(new Set(hits.map((h) => h.reasonCode).filter(Boolean)));
  return {
    verdict: 'PASS',
    actualCode: codes.join(', ') || '(entry present, reason not parsed)',
    actualDescription: hits[0].raw.slice(0, 120),
    actualDestination: 'ADBSKIP',
    notes:
      `${hits.length} skip entry(s) at record(s) ` +
      `${hits.map((h) => h.recordPosition).join(', ')}` +
      (wanted && !codes.includes(wanted)
        ? `. Expected skip reason ${wanted}; the report carries ${codes.join(', ') || 'none'}.`
        : '.'),
  };
}

/**
 * A case whose bundle is valid by design: the expected outcome is that the header
 * controls are reported as satisfied and the run proceeds.
 */
export function judgeControlsSatisfied(
  tc: TestCase,
  run: RunRecord,
  cntl: ControlReport | null,
): Decision {
  if (!cntl) {
    return {
      verdict: 'BLOCKED',
      actualCode: '(none)',
      actualDescription: '',
      actualDestination: '(no control report)',
      notes: 'The run produced no control report, so the header controls cannot be read.',
    };
  }
  const { failed, lines } = headerControlFailed(cntl);
  const completed = String(run.runStatus).toUpperCase() === 'COMPLETED';
  const pass = completed && !failed && lines.length > 0;
  return {
    verdict: pass ? 'PASS' : 'FAIL',
    actualCode: completed ? 'run COMPLETED' : `run ${run.runStatus}`,
    actualDescription: lines.slice(0, 3).join(' | ').slice(0, 200),
    actualDestination: 'CNTLRPT',
    notes: pass
      ? `The run completed and the control report records the header controls without a failure: ` +
        `${lines.length} control line(s).`
      : lines.length === 0
        ? 'The control report carries no recognisable header-control line, so the controls cannot ' +
          'be confirmed as satisfied.'
        : `Expected the controls to be satisfied. Run status ${run.runStatus}; ` +
          `control lines: ${lines.slice(0, 3).join(' | ').slice(0, 160)}`,
  };
}

/** A case whose outcome is a header control failing and the run stopping. */
export function judgeHeaderControl(
  tc: TestCase,
  run: RunRecord,
  cntl: ControlReport | null,
): Decision {
  if (!cntl) {
    return {
      verdict: 'BLOCKED',
      actualCode: '(none)',
      actualDescription: '',
      actualDestination: '(no control report)',
      notes: 'The run produced no control report, so the header controls cannot be read.',
    };
  }
  const { failed, lines } = headerControlFailed(cntl);
  const stopped = String(run.runStatus).toUpperCase() === 'FAILED';
  const pass = failed || stopped;
  return {
    verdict: pass ? 'PASS' : 'FAIL',
    actualCode: stopped ? 'run FAILED' : '(run completed)',
    actualDescription: lines.slice(0, 3).join(' | ').slice(0, 200),
    actualDestination: 'CNTLRPT',
    notes: pass
      ? `The run ended ${run.runStatus} and the control report records the header controls. ` +
        'This matches the expected outcome: the header is refused and no records are processed.'
      : 'The run completed and no header control is reported as failing. The deliberately ' +
        'invalid header was accepted.',
  };
}

/**
 * What the Live console said became of the uploaded file. This is the application's
 * own account of the run, and it is the quickest way to see whether a record was
 * committed, rolled back or set aside.
 */
export function consoleSays(run: RunRecord): string {
  const o = run.outcome;
  if (!o) return '';
  const warn = o.warnings.length ? ` ${o.warnings.length} warning(s) logged.` : '';
  return ` Live console: ${o.committed} bundle(s) committed, ${o.rolledBack} rolled back, ` +
    `${o.skipped} record(s) skipped.${warn}`;
}

/**
 * Where a bundle's output actually landed, across every artifact we download.
 * Reported on a failure so the verdict says more than "not here".
 */
export function whereItLanded(
  tc: TestCase,
  run: RunRecord,
  refusals: LnaRefusal[],
  skips: SkipEntry[],
): string[] {
  const seen: string[] = [];
  const mine = tc.feeds.filter((f) => f.feed === run.feedFile);
  if (mine.some((f) => refusalsInRange(refusals, f.recordStart, f.recordEnd).length)) {
    seen.push('LNAERROR');
  }
  if (mine.some((f) => skipsInRange(skips, f.recordStart, f.recordEnd).length)) {
    seen.push('ADBSKIP');
  }
  const load = run.artifacts?.LOADFILE;
  if (load && fs.existsSync(load) && mine.some((f) => f.bd && artifactContains(load, f.bd))) {
    seen.push('LOADFILE');
  }
  return seen;
}

/**
 * The verification the BRD asks for: did the output land in the right place?
 *
 * "The right place" depends on what the record is, not only on what the rule says.
 *
 *   The feed forces the rule's condition -> the record must reach the destination
 *   the BRD assigns to that rule.
 *
 *   The feed does NOT force it -> the record is valid, so the right place is the
 *   successful output. A valid record cannot appear on an error report, and
 *   landing in the load output is the correct outcome, not a failure.
 *
 * Either way the expected error code is evidence, not the gate. Output reaching
 * its destination under a different code is a discrepancy worth recording.
 */
export function judgeDestination(
  tc: TestCase,
  run: RunRecord,
  refusalsAll: LnaRefusal[],
  skipsAll: SkipEntry[],
  cntl: ControlReport | null,
): Decision {
  const mine = tc.feeds.filter((f) => f.feed === run.feedFile);
  const positions = mine.map((f) => `${f.recordStart}-${f.recordEnd}`).join(', ');
  const want = tc.destinationArtifact;

  const refusals = mine.flatMap((f) => refusalsInRange(refusalsAll, f.recordStart, f.recordEnd));
  const skips = mine.flatMap((f) => skipsInRange(skipsAll, f.recordStart, f.recordEnd));
  const load = run.artifacts?.LOADFILE;
  const bd = mine.find((f) => f.bd)?.bd ?? '';
  const applied = !!load && !!bd && fs.existsSync(load) && artifactContains(load, bd);

  const lnaCodes = Array.from(new Set(refusals.map((h) => h.errorCode))).join(', ');
  const skipCodes = Array.from(new Set(skips.map((h) => h.reasonCode).filter(Boolean))).join(', ');

  // ---- the record is valid: the successful output is where it belongs ------
  if (!tc.conditionForced) {
    if (applied && refusals.length === 0 && skips.length === 0) {
      return {
        verdict: 'PASS',
        actualCode: '(none - no error expected)',
        actualDescription: `identifier ${bd} present in the load output`,
        actualDestination: 'LOADFILE',
        notes:
          `The feed file does not force this rule's condition, so the record is valid and belongs ` +
          `in the successful output. It was applied: identifier ${bd} is in the load output, with ` +
          `no refusal and no skip entry for record(s) ${positions}. Routing is correct for what the ` +
          `record is. This confirms the destination, not the rule's own condition.` + consoleSays(run),
      };
    }
    const wrong = [
      refusals.length ? `LNAERROR (${lnaCodes})` : '',
      skips.length ? `ADBSKIP (reason ${skipCodes})` : '',
    ].filter(Boolean);
    return {
      verdict: 'FAIL',
      actualCode: lnaCodes || skipCodes || '(none)',
      actualDescription: wrong.join(', ') || '(no output found)',
      actualDestination: wrong.join(', ') || '(none)',
      notes: wrong.length
        ? `A valid record was refused. Record(s) ${positions} reached ${wrong.join(' and ')}, but ` +
          'nothing in this bundle violates a rule, so it should have been applied.' + consoleSays(run)
        : `Record(s) ${positions} were neither refused nor applied - the identifier ${bd} is absent ` +
          'from the load output and no error report carries them.' + consoleSays(run),
    };
  }

  // ---- the condition IS forced: the rule's own destination is required ----
  let present = false;
  let code = '';
  let evidence = '';
  if (want === 'LNAERROR') {
    present = refusals.length > 0;
    code = lnaCodes;
    evidence = refusals.map((h) => `${h.errorCode} at record ${h.recordPosition}`).join('; ');
  } else if (want === 'ADBSKIP') {
    present = skips.length > 0;
    code = skipCodes;
    evidence = skips.map((h) => `reason ${h.reasonCode} at record ${h.recordPosition}`).join('; ');
  } else if (want === 'CNTLRPT') {
    present = !!cntl && cntl.lines.length > 0;
    evidence = cntl ? `${cntl.lines.length} control-report line(s)` : '';
  } else if (want === 'LOADFILE') {
    present = applied;
    evidence = present ? `identifier ${bd} present in the load output` : '';
  }

  if (present) {
    const mismatch =
      tc.expectedCode && code && !code.split(', ').includes(tc.expectedCode)
        ? ` The BRD names ${tc.expectedCode} for this rule; the output carries ${code}. The ` +
          'destination is right, the code differs - worth confirming which is correct.'
        : '';
    return {
      verdict: 'PASS',
      actualCode: code || '(no code - output present)',
      actualDescription: evidence,
      actualDestination: want,
      notes: `Output present at ${want} for record(s) ${positions}. ${evidence}${mismatch}`
        + consoleSays(run),
    };
  }

  const elsewhere = whereItLanded(tc, run, refusalsAll, skipsAll);
  return {
    verdict: 'FAIL',
    actualCode: lnaCodes || skipCodes || '(none)',
    actualDescription: elsewhere.length ? `output found at ${elsewhere.join(', ')}` : '(no output found)',
    actualDestination: elsewhere.join(', ') || '(none)',
    notes:
      `The feed forces this rule's condition, so output was expected at ${want} for record(s) ` +
      `${positions}. Nothing is there. ` +
      (elsewhere.length
        ? `The output went to ${elsewhere.join(', ')} instead, so the routing differs from the ` +
          'destination the BRD assigns.'
        : 'No output for these records was found in any downloaded artifact.') + consoleSays(run),
  };
}
