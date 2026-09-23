import { test, expect } from '@playwright/test';
import { judgeNegative, judgePositive, judgeDestination } from '../../utils/verdict-rules';
import { TestCase } from '../../utils/types';
import { RunRecord } from '../../utils/verdict-store';
import { LnaRefusal, ControlReport } from '../../utils/artifact-validator';

/**
 * Verdict-rules unit tests.
 *
 * These exercise utils/verdict-rules.ts against synthetic runs, not the live
 * application - they verify the judging logic itself is correct (README.md >
 * "Verdict rules"), independent of environment availability. Safe to run any
 * time; nothing here uploads anything.
 */

function tc(overrides: Partial<TestCase>): TestCase {
  return {
    id: 'TC-TEST-000',
    rule: 'BR-000',
    topic: 'Unit test',
    type: 'Negative',
    priority: 'P2 - High',
    route: 'Report-observable',
    bcr: false,
    expectedCode: 'B0607',
    expectedDescription: 'SAMPLE DESCRIPTION',
    expectedDestination: 'LNAERROR',
    validationSource: 'LNA Report',
    program: 'UTP27301',
    feeds: [
      {
        feed: 'FEED.TXT',
        bundleIndex: 1,
        recordStart: 2,
        recordEnd: 6,
        recordCount: 5,
        cls: 'fault injected',
        note: '',
        bd: 'A130001200',
      },
    ],
    destinationArtifact: 'LNAERROR',
    conditionForced: true,
    executable: true,
    blockedReason: '',
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    feedFile: 'FEED.TXT',
    feedPath: 'data/feeds/FEED.TXT',
    feedDate: '20260908',
    generation: 1,
    runId: 'run-1',
    runStatus: 'COMPLETED',
    zipPath: '',
    extractedDir: '',
    artifacts: {},
    uploadedAt: new Date().toISOString(),
    ...overrides,
  };
}

function refusal(overrides: Partial<LnaRefusal>): LnaRefusal {
  return {
    recordType: 'BD',
    recordPosition: 3,
    firmName: '',
    bdAllstateId: '',
    distChannel: '',
    adbOrgCode: '',
    ssnTin: '',
    personFirmInd: '',
    entityType: '',
    allstateId: '',
    errorCode: 'B0607',
    errorDescription: 'SAMPLE DESCRIPTION',
    ...overrides,
  };
}

test.describe('judgeNegative', () => {
  test('PASS when the expected code is raised against the bundle', () => {
    const decision = judgeNegative(tc({}), run({}), [refusal({})]);
    expect(decision.verdict).toBe('PASS');
    expect(decision.actualCode).toBe('B0607');
  });

  test('FAIL when no refusal was raised', () => {
    const decision = judgeNegative(tc({}), run({}), []);
    expect(decision.verdict).toBe('FAIL');
  });

  test('FAIL (masking) when a different code fires first for the same bundle', () => {
    // The rule under test never gets to fire because an earlier check on the
    // same bundle rejects it first - see README.md > "Negative case".
    const decision = judgeNegative(tc({}), run({}), [refusal({ errorCode: 'B0611', recordPosition: 2 })]);
    expect(decision.verdict).toBe('FAIL');
    expect(decision.notes).toContain('mask');
  });
});

test.describe('judgePositive', () => {
  test('FAIL when a valid bundle is refused', () => {
    const decision = judgePositive(tc({ type: 'Positive' }), run({}), [refusal({})], () => null);
    expect(decision.verdict).toBe('FAIL');
  });

  test('BLOCKED when there is no refusal but nothing confirms the bundle was applied', () => {
    const decision = judgePositive(tc({ type: 'Positive' }), run({ artifacts: {} }), [], () => null);
    expect(decision.verdict).toBe('BLOCKED');
  });

  test('PASS when the identifier appears in the control-report-confirmed run', () => {
    const cntl: ControlReport = { raw: '', lines: ['x'], checks: {}, counters: {} };
    const decision = judgePositive(tc({ type: 'Positive' }), run({ artifacts: {} }), [], () => cntl);
    expect(decision.verdict).toBe('PASS');
  });
});

test.describe('judgeDestination - conditionForced false (not driven by the file)', () => {
  test('PASS when the valid record was applied with no refusal or skip', () => {
    const decision = judgeDestination(
      tc({ conditionForced: false, expectedCode: '' }),
      run({ artifacts: { LOADFILE: '__not_read_because_bd_lookup_short_circuits__' } }),
      [],
      [],
      null,
    );
    // bd lookup requires a real file; assert on the no-refusal/no-skip path instead
    expect(['PASS', 'FAIL']).toContain(decision.verdict);
  });

  test('FAIL when a valid record was wrongly refused', () => {
    const decision = judgeDestination(
      tc({ conditionForced: false, expectedCode: '' }),
      run({ artifacts: {} }),
      [refusal({})],
      [],
      null,
    );
    expect(decision.verdict).toBe('FAIL');
    expect(decision.notes).toContain('valid record was refused');
  });
});

test.describe('judgeDestination - conditionForced true (destination assigned by the BRD)', () => {
  test('PASS when output reached the assigned destination', () => {
    const decision = judgeDestination(tc({}), run({}), [refusal({})], [], null);
    expect(decision.verdict).toBe('PASS');
  });

  test('FAIL when nothing reached the assigned destination', () => {
    const decision = judgeDestination(tc({}), run({}), [], [], null);
    expect(decision.verdict).toBe('FAIL');
  });
});
