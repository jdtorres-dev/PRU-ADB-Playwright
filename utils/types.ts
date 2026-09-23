/**
 * Shared types for the test-case and feed registries.
 *
 * These mirror data/test-cases.json and data/feeds.json exactly. Those files -
 * generated from the BRD v4 workbook (PRU_ADB_E2E_Test_Scenarios_v4.xlsx) by
 * scripts/build_registry.py - are the definition of record. Nothing in this
 * project carries its own copy of an expected error code, description or
 * destination; everything is read from here.
 */

export interface FeedTarget {
  /** Feed file this rule's records live in. */
  feed: string;
  /** 1-based bundle number within the file. */
  bundleIndex: number;
  /** Record positions the bundle occupies, counting the submitting header as 1. */
  recordStart: number;
  recordEnd: number;
  recordCount: number;
  /**
   * How the record is driven:
   *   fault injected  the condition is forced by a field value in the file
   *   structural       the condition is forced by the shape of the bundle
   *   positive         the expected outcome is success
   *   precondition     depends on what is already committed in ADB
   *   header-level     sits on the submitting header, needs a file of its own
   *   carrier ...      the rule's fields have no position in the feed layout
   */
  cls: string;
  note: string;
  bd: string;
}

export interface TestCase {
  id: string;
  rule: string;
  topic: string;
  type: 'Negative' | 'Positive' | 'Interaction' | 'Behaviour-documenting' | string;
  priority: string;
  route: string;
  /** Confidence C in BRD v4 - observe and record, never Pass or Fail. */
  bcr: boolean;
  expectedCode: string;
  expectedDescription: string;
  expectedDestination: string;
  validationSource: string;
  program: string;
  feeds: FeedTarget[];
  classes?: string[];
  /** LNAERROR | ADBSKIP | CNTLRPT | LOADFILE | ERRFILE | '' - where the BRD says the output goes. */
  destinationArtifact: string;
  /** True when the feed file actually forces the rule's condition. */
  conditionForced: boolean;
  /** True only when the condition is actually forced by the file - the only cases that can Pass/Fail. */
  executable: boolean;
  blockedReason: string;
}

export interface Feed {
  file: string;
  /** Path as recorded at registry build time. Do not read from this directly - see feedAbsolutePath(). */
  path: string;
  /** setup | error-code | destination | java-recovered | positive | state */
  family: string;
  code: string;
  destination: string;
  /** 0 = a setup file that commits state, uploaded first. 1 = everything else. */
  phase: number;
  records: number;
  bundles: number;
  cases: string[];
}

export interface Generation {
  generation: number;
  issuedAt: string;
  feedDir: string;
}
