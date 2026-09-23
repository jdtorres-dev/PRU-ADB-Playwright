import AdmZip from 'adm-zip';
import { decodeCp037 } from './cp037';
import * as fs from 'fs';
import * as path from 'path';

export interface LnaRefusal {
  recordType: string;
  recordPosition: number;
  firmName: string;
  bdAllstateId: string;
  distChannel: string;
  adbOrgCode: string;
  ssnTin: string;
  personFirmInd: string;
  entityType: string;
  allstateId: string;
  errorCode: string;
  errorDescription: string;
}

export interface ExtractedArtifacts {
  dir: string;
  files: string[];
  lnaReportPath?: string;
  cntlrptPath?: string;
}

/** Unpacks the General Artifacts ZIP and locates the LNA report and the control report. */
export function extractArtifacts(zipPath: string, outDir: string): ExtractedArtifacts {
  fs.mkdirSync(outDir, { recursive: true });
  new AdmZip(zipPath).extractAllTo(outDir, true);

  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(outDir);

  const byName = (re: RegExp) => files.find((f) => re.test(path.basename(f).toLowerCase()));
  return {
    dir: outDir,
    files,
    lnaReportPath: byName(/lnaerror|lna[-_]?report/),
    cntlrptPath: byName(/cntlrpt|control[-_]?report/),
  };
}

/**
 * Parses the tilde-delimited LNA refusal report.
 * Field order is fixed by the 27301 LNAERROR copybook:
 *   type ~ position ~ firm ~ bdId ~ distCh ~ orgCode ~ ssn ~ personFirm ~ entity ~ allstateId ~ code ~ description
 */
export function parseLnaReport(filePath: string): LnaRefusal[] {
  const raw = fs.readFileSync(filePath, 'latin1');
  const out: LnaRefusal[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = line.split('~').map((s) => s.trim());
    if (p.length < 12) continue;
    out.push({
      recordType: p[0],
      recordPosition: Number(p[1]),
      firmName: p[2],
      bdAllstateId: p[3],
      distChannel: p[4],
      adbOrgCode: p[5],
      ssnTin: p[6],
      personFirmInd: p[7],
      entityType: p[8],
      allstateId: p[9],
      errorCode: p[10],
      errorDescription: p[11],
    });
  }
  return out;
}

export interface ControlReport {
  raw: string;
  lines: string[];
  checks: Record<string, string>;
  counters: Record<string, number>;
}

/**
 * Reads the control report. Lines are of the form
 *   "     SOME CHECK DESCRIPTION            : YES"
 *   "     NUMBER OF SOMETHING               : 0000000005"
 */
export function parseControlReport(filePath: string): ControlReport {
  const raw = fs.readFileSync(filePath, 'latin1');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const checks: Record<string, string> = {};
  const counters: Record<string, number> = {};
  for (const line of lines) {
    const m = line.match(/^\s*(.+?)\s*:\s*(\S+)\s*$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim();
    if (/^\d+$/.test(value)) counters[key] = Number(value);
    else checks[key] = value;
  }
  return { raw, lines, checks, counters };
}

/** Finds the refusal that belongs to a given producer record position. */
export function refusalAtRecord(refusals: LnaRefusal[], recordPosition: number): LnaRefusal | undefined {
  return refusals.find((r) => r.recordPosition === recordPosition);
}

/* ------------------------------------------------------------------------ *
 * E2E additions.
 *
 * The demo needed the LNA report and the control report. The E2E suite judges
 * cases against several destinations, and positive cases against what was
 * actually written, so the whole artifact set has to be addressable.
 * ------------------------------------------------------------------------ */

/** Logical artifact names as they appear in the General Artifacts ZIP. */
export type ArtifactName =
  | 'CNTLRPT'
  | 'LOADFILE'
  | 'LNAERROR'
  | 'ADBSKIP'
  | 'ADBERROR'
  | 'NEWBD'
  | 'ADSIMSTR'
  | 'SQLDUMP';

const ARTIFACT_PATTERNS: Array<[ArtifactName, RegExp]> = [
  ['CNTLRPT', /^cntlrpt.*\.txt$/i],
  ['LNAERROR', /^lnaerror.*\.txt$/i],
  ['ADBSKIP', /^adbskip.*\.txt$/i],
  ['ADBERROR', /^adberror.*\.txt$/i],
  ['NEWBD', /^newbd.*\.txt$/i],
  ['LOADFILE', /^loadfile.*\.dat$/i],
  ['ADSIMSTR', /^aladsi.*\.dat$/i],
  ['SQLDUMP', /^(organization_record|contract_record|master_control).*\.txt$/i],
];

/**
 * Maps every artifact in an extracted ZIP to its logical name.
 * Copybooks (.cpy) are skipped — they describe the layout, they are not output.
 */
export function locateArtifacts(extractedDir: string): Partial<Record<ArtifactName, string>> {
  const found: Partial<Record<ArtifactName, string>> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (e.name.toLowerCase().endsWith('.cpy')) continue;
      for (const [name, re] of ARTIFACT_PATTERNS) {
        if (re.test(e.name) && !found[name]) found[name] = p;
      }
    }
  };
  walk(extractedDir);
  return found;
}

/**
 * Destinations named in BRD v4 that have no downloadable artifact.
 * A case expecting one of these cannot return Pass or Fail from a download.
 */
export const UNOBSERVABLE_DESTINATIONS = [
  'Java exception',
  'Log only',
  'ERRFILE',
  'Returned status \u2192 ERRFILE',
  'None (control flow)',
  'None (silent)',
];

/** Every refusal raised against a record inside a given bundle. */
export function refusalsInRange(
  refusals: LnaRefusal[],
  recordStart: number,
  recordEnd: number,
): LnaRefusal[] {
  return refusals.filter((r) => r.recordPosition >= recordStart && r.recordPosition <= recordEnd);
}

/**
 * The LOADFILE is EBCDIC. Decoding it is the only way to confirm that a positive
 * case actually landed in the load output rather than merely avoiding a refusal.
 */
export function readLoadFileAsText(loadFilePath: string): string {
  // Node's TextDecoder has no 'ibm037' encoding and throws RangeError for it,
  // so the mapping is carried in src/cp037.ts.
  return decodeCp037(fs.readFileSync(loadFilePath));
}

/** True when an identifier appears in a file, EBCDIC or otherwise. */
export function artifactContains(filePath: string, needle: string): boolean {
  if (!needle) return false;
  const lower = path.basename(filePath).toLowerCase();
  const text = lower.endsWith('.dat')
    ? readLoadFileAsText(filePath)
    : fs.readFileSync(filePath, 'latin1');
  return text.includes(needle);
}

/** Reads a counter from the control report, or null when the line is absent. */
export function counterMatching(report: ControlReport, pattern: RegExp): number | null {
  for (const [k, v] of Object.entries(report.counters)) {
    if (pattern.test(k)) return v;
  }
  return null;
}


/* ------------------------------------------------------------------------ *
 * Skip report and control report.
 *
 * Rules recovered from Destination Detail (Java) land on ADBSKIP or CNTLRPT
 * rather than in the LNA report, so those two need reading as well.
 * ------------------------------------------------------------------------ */

export interface SkipEntry {
  /** Position of the skipped record within the uploaded feed file. */
  recordPosition: number;
  /** 001 INVALID_RECORD_TYPE, 002 EARLIER_BUNDLE_RECORD_FAILED. */
  reasonCode: string;
  raw: string;
}

/**
 * Parses the skip report. The layout carries the record's position and its skip
 * reason, followed by the raw 600-byte input record. Position and reason are read
 * from the leading fields; the rest is kept verbatim for evidence.
 */
export function parseSkipReport(filePath: string): SkipEntry[] {
  const raw = fs.readFileSync(filePath, 'latin1');
  const out: SkipEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*(\d+)\s*[~|]?\s*(\d{3})/);
    if (m) {
      out.push({ recordPosition: Number(m[1]), reasonCode: m[2], raw: line });
    } else {
      out.push({ recordPosition: NaN, reasonCode: '', raw: line });
    }
  }
  return out;
}

/** Skip entries raised against records inside a given bundle. */
export function skipsInRange(
  entries: SkipEntry[],
  recordStart: number,
  recordEnd: number,
): SkipEntry[] {
  return entries.filter(
    (e) => !Number.isNaN(e.recordPosition) &&
      e.recordPosition >= recordStart && e.recordPosition <= recordEnd,
  );
}

/**
 * True when the control report shows a header control failing.
 * The three controls are the partner name, the transmission date and the record count.
 */
export function headerControlFailed(report: ControlReport): { failed: boolean; lines: string[] } {
  const lines = report.lines.filter((l) =>
    /COMPANY|PARTNER NAME|TRANS(MISSION)? DATE|RECORD COUNT|REC COUNT/i.test(l),
  );
  const failed = lines.some((l) => /NO|INVALID|MISMATCH|NOT MATCH|FAIL/i.test(l));
  return { failed, lines };
}
