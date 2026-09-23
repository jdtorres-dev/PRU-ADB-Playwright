// Types for the isolated "BRv4 uncovered rules" E2E suite (189 new test cases,
// one per previously-uncovered BRD v4 business rule - see
// reference-docs/Test Cases/PRU_ADB_New_E2E_Test_Cases_BRv4.xlsx).
//
// Deliberately separate from utils/types.ts: these rules carry no LNA error
// code, so their shape (verificationRoute / automationEligibility / checks)
// does not fit the existing TestCase interface, and this suite must stay
// isolated from the original 85-feed/284-case registry.

export interface FeedTargetBrv4 {
  feed: string;
  bundleIndex: number;
  recordStart: number;
  recordEnd: number;
  recordCount: number;
  cls: string;
  note: string;
  bd: string;
}

export type VerificationRoute =
  | 'Database-observable'
  | 'Control-report-observable'
  | 'Application-observable'
  | 'Log-observable'
  | 'Output-file-observable'
  | 'API-observable';

export type AutomationEligibility =
  | 'Eligible - assert on report content'
  | 'Eligible - assert on log/output'
  | 'Eligible - assert on database state'
  | 'Not eligible - requires manual verification';

export type ArtifactCheckKind =
  | 'controlReportCounterAtLeast'
  | 'artifactContains'
  | 'artifactNotContains'
  | 'skipReportReasonAtPosition';

export interface ArtifactCheck {
  kind: ArtifactCheckKind;
  artifact: 'CNTLRPT' | 'LNAERROR' | 'ADBSKIP' | 'ADBERROR' | 'LOADFILE';
  description: string;
  // controlReportCounterAtLeast
  counterLabel?: string;
  minValue?: number;
  // artifactContains / artifactNotContains
  needle?: string;
  // skipReportReasonAtPosition
  identifierNeedle?: string;
  expectedReason?: string;
}

export interface TestCaseBrv4 {
  id: string; // TC-BR-<n>
  rule: string; // BR-<n>
  businessRuleDescription: string;
  topic: string;
  type: string;
  priority: string;
  verificationRoute: VerificationRoute;
  automationEligibility: AutomationEligibility;
  fieldsUnderTest: string;
  triggerCondition: string;
  isolationRequirement: string;
  validationSource: string;
  expectedDestination: string;
  expectedBusinessOutcome: string;
  expectedDisposition: string;
  expectedDataEffect: string;
  sourceProgram: string;
  verificationBasis: string;

  feeds: FeedTargetBrv4[]; // [] when no feed mechanism exists at all
  checks: ArtifactCheck[]; // [] when executable === false

  executable: boolean;
  blockedReason: string;

  dbVerificationRequired: boolean;
  dbVerificationNotes: string;
}

export interface FeedBrv4 {
  file: string;
  path: string;
  role: 'single' | 'setup' | 'test';
  phase: number; // 0 = setup (uploaded first), 1 = single/test
  records: number;
  bundles: number;
  cases: string[];
}

export interface GenerationBrv4 {
  generation: number;
  issuedAt: string;
  note: string;
}
