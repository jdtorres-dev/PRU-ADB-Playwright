import * as fs from 'fs';
import * as path from 'path';

// Reusable feed-construction helpers for the BRv4 suite, ported from the
// validated logic in scripts/make-feeds-brv4.js. Every identity minted here
// uses generation 99 (reserved exclusively for this suite - see
// data/generation.brv4.json) plus a caller-supplied sequence, so callers must
// pass a sequence unique across every feed built in one test run.

interface Layout { [field: string]: Array<[string, number, number]>; }
const LAYOUT: Layout = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'layout.json'), 'utf8'));
const SPAN: Record<string, [number, number]> = {};
for (const [field, places] of Object.entries(LAYOUT)) {
  for (const [kind, s, e] of places) SPAN[`${kind}\u0000${field}`] = [s, e];
}

const RECLEN = 600;
const FEED_DATE = '20260908';
const GEN = 99;

function put(rec: string, span: [number, number], val: string): string {
  const [s, e] = span;
  const n = e - s + 1;
  const v = String(val);
  if (v.length > n) throw new Error(`value "${v}" (${v.length}) longer than field width ${n}`);
  const out = Buffer.from(rec, 'latin1');
  Buffer.from(v.padEnd(n, ' '), 'latin1').copy(out, s - 1);
  return out.toString('latin1');
}
export function setf(rec: string, kind: string, field: string, val: string): string {
  const sp = SPAN[`${kind}\u0000${field}`];
  if (!sp) throw new Error(`field ${field} not in layout for ${kind}`);
  return put(rec, sp, val);
}

let baselineCache: string[] | null = null;
function baseline(): string[] {
  if (!baselineCache) {
    const lines = fs
      .readFileSync(path.join(__dirname, '..', 'data', 'feeds', 'ALLSTATE.LNA.POS-VALID-BASELINE.D20260908.txt'), 'latin1')
      .split('\r\n')
      .filter((l) => l.length > 0);
    baselineCache = lines.slice(0, 6);
  }
  return baselineCache;
}

export interface Identity {
  bd: string;
  tax: string;
  ssn: string;
  pid: string;
  firmName: string;
  abbrFirmName: string;
}
export function identity(seq: number): Identity {
  const g = String(GEN).padStart(2, '0');
  const s5 = String(seq).padStart(5, '0');
  return {
    bd: `A${g}${s5}00`,
    tax: `${g}${String(1000000 + seq).padStart(7, '0')}`,
    ssn: `${g}${String(5000000 + seq).padStart(7, '0')}`,
    pid: `P${g}${s5}00`,
    firmName: `E2E BRV4 BD${s5} LLC`,
    abbrFirmName: `E2E BRV4 BD${s5}`,
  };
}

export function buildFirm(seq: number, overrides: { B?: Record<string, string>; C?: Record<string, string> } = {}) {
  const [, B0, C0] = baseline();
  const id = identity(seq);
  let B = B0, C = C0;
  B = setf(B, 'B', 'WS-ALLST-FIRM-NAME', id.firmName);
  B = setf(B, 'B', 'WS-BD-ALLSTATE-ID', id.bd);
  C = setf(C, 'C', 'WS-TAX-ID-NUM', id.tax);
  C = setf(C, 'C', 'WS-FIRM-NAME', id.firmName);
  C = setf(C, 'C', 'WS-ABBR-FIRM-NAME', id.abbrFirmName);
  C = setf(C, 'C', 'WS-ALLSTATE-ID', id.bd);
  C = setf(C, 'C', 'WS-BD-ALLSTATE-ID', id.bd);
  C = setf(C, 'C', 'WS-FIRM-ALLSTATE-ID', id.bd);
  for (const [field, val] of Object.entries(overrides.C || {})) C = setf(C, 'C', field, val);
  for (const [field, val] of Object.entries(overrides.B || {})) B = setf(B, 'B', field, val);
  return { B, C, id };
}

// A "subsequent firm" (LLE/HA) presented under a valid BD's bundle.
export function buildSubsequentFirm(seq: number, parentBd: string, overrides: { C?: Record<string, string> } = {}) {
  const [, , C0] = baseline();
  const id = identity(seq);
  const lle = `L${String(GEN).padStart(2, '0')}${String(seq).padStart(5, '0')}00`;
  let C = C0;
  C = setf(C, 'C', 'WS-TAX-ID-NUM', id.tax);
  C = setf(C, 'C', 'WS-FIRM-NAME', `E2E BRV4 SUB${String(seq).padStart(5, '0')} LLC`);
  C = setf(C, 'C', 'WS-ABBR-FIRM-NAME', `E2E BRV4 SUB${String(seq).padStart(5, '0')}`);
  C = setf(C, 'C', 'WS-ALLSTATE-ID', lle);
  C = setf(C, 'C', 'WS-ENTITY-TYPE', 'LLE');
  C = setf(C, 'C', 'WS-BD-ALLSTATE-ID', parentBd);
  C = setf(C, 'C', 'WS-FIRM-ALLSTATE-ID', lle);
  for (const [field, val] of Object.entries(overrides.C || {})) C = setf(C, 'C', field, val);
  return { C, id: { ...id, bd: lle } };
}

export function buildProducer(
  seq: number,
  bd: string,
  firmId: string,
  relnStatus: string,
  overrides: { D01?: Record<string, string>; D02?: Record<string, string> } = {},
) {
  const [, , , D010, D020] = baseline();
  const id = identity(seq);
  let D1 = D010, D2 = D020;
  D1 = setf(D1, 'D01', 'WS-SOC-SEC-NUM', id.ssn);
  D2 = setf(D2, 'D02', 'WS-SOC-SEC-NUM', id.ssn);
  D2 = setf(D2, 'D02', 'WS-ALLSTATE-ID', id.pid);
  D2 = setf(D2, 'D02', 'WS-FIRM-ALLSTATE-ID', firmId);
  D2 = setf(D2, 'D02', 'WS-BD-ALLSTATE-ID', bd);
  D2 = setf(D2, 'D02', 'WS-RELN-STATUS', relnStatus);
  D2 = setf(D2, 'D02', 'WS-RELN-START-DT', '20260101');
  D2 = setf(D2, 'D02', 'WS-RELN-END-DT', relnStatus === 'A' ? '99999999' : '20260908');
  for (const [field, val] of Object.entries(overrides.D01 || {})) D1 = setf(D1, 'D01', field, val);
  for (const [field, val] of Object.entries(overrides.D02 || {})) D2 = setf(D2, 'D02', field, val);
  return { D1, D2, id };
}

export const Z_TRAILER = baseline()[5] ?? '';

export function assembleFile(fileName: string, bundles: string[][], feedDate: string = FEED_DATE): { records: number; bundles: number } {
  const [A0] = baseline();
  const body: string[] = [];
  for (const b of bundles) body.push(...b);
  const total = 1 + body.length;
  let A = A0;
  A = setf(A, 'A', 'WS-COMPANY-NAME', 'ALLSTATE');
  A = setf(A, 'A', 'WS-TRANS-DATE', feedDate);
  A = setf(A, 'A', 'WS-TOT-REC-COUNT', String(total).padStart(12, '0'));
  const recs = [A, ...body];
  for (const r of recs) if (r.length !== RECLEN) throw new Error(`record wrong length in ${fileName}`);
  const dir = path.join(__dirname, '..', 'data', 'feeds');
  fs.writeFileSync(path.join(dir, fileName), recs.join('\r\n') + '\r\n', 'latin1');
  return { records: total, bundles: bundles.length };
}

export const FEEDS_DIR = path.join(__dirname, '..', 'data', 'feeds');
