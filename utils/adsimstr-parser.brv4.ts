// Reads and decodes the raw ADSIMSTR extract (File 7 in the "download all
// artifacts" ZIP) directly, per its own copybook (ADSIMSTR.cpy, also in
// that ZIP - byte positions below are copied straight from it). This
// exists because several BRv4 rules ask about fields the broken/missing
// mainframe-vs-Java comparator would normally show, but which are
// self-contained facts about the Java-built extract itself - checkable
// without any comparator or historical mainframe reference, as long as we
// can read the extract's own bytes. The file is EBCDIC (CP037) text with
// COMP-3 packed-decimal counters; both are decoded here directly, with no
// external dependency.

// Standard IBM CP037 (EBCDIC US/Canada) -> ASCII byte mapping.
const CP037_TO_ASCII: number[] = new Array(256).fill(0x3f);
function set(ebc: number, asc: number) { CP037_TO_ASCII[ebc] = asc; }
set(0x40, 0x20);
const lower1 = 'abcdefghi', lower2 = 'jklmnopqr', lower3 = 'stuvwxyz';
for (let i = 0; i < lower1.length; i++) set(0x81 + i, lower1.charCodeAt(i));
for (let i = 0; i < lower2.length; i++) set(0x91 + i, lower2.charCodeAt(i));
for (let i = 0; i < lower3.length; i++) set(0xa2 + i, lower3.charCodeAt(i));
const upper1 = 'ABCDEFGHI', upper2 = 'JKLMNOPQR', upper3 = 'STUVWXYZ';
for (let i = 0; i < upper1.length; i++) set(0xc1 + i, upper1.charCodeAt(i));
for (let i = 0; i < upper2.length; i++) set(0xd1 + i, upper2.charCodeAt(i));
for (let i = 0; i < upper3.length; i++) set(0xe2 + i, upper3.charCodeAt(i));
for (let i = 0; i < 10; i++) set(0xf0 + i, '0'.charCodeAt(0) + i);
set(0x4b, 0x2e); set(0x60, 0x2d); set(0x61, 0x2f); set(0x6b, 0x2c); set(0x7c, 0x40); set(0x5b, 0x24);

/** Splits the extract into its variable-length, newline-delimited records. */
export function splitAdsimstrRecords(buf: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      records.push(buf.slice(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) records.push(buf.slice(start));
  return records;
}

/** 1-based inclusive start position, matching ADSIMSTR.cpy exactly. */
export function ebcdicField(rec: Buffer, startPos: number, len: number): string {
  const slice = rec.slice(startPos - 1, startPos - 1 + len);
  let out = '';
  for (const b of slice) out += String.fromCharCode(CP037_TO_ASCII[b]);
  return out.replace(/\s+$/, '');
}

/** COMP-3 packed decimal: 2 BCD digits/byte, sign nibble in the last byte's low nibble. */
export function comp3Field(rec: Buffer, startPos: number, byteLen: number): number {
  const slice = rec.slice(startPos - 1, startPos - 1 + byteLen);
  let digits = '';
  let sign = 0xc;
  for (let i = 0; i < slice.length; i++) {
    const hi = (slice[i] >> 4) & 0xf;
    const lo = slice[i] & 0xf;
    if (i === slice.length - 1) { digits += String(hi); sign = lo; }
    else digits += String(hi) + String(lo);
  }
  const value = parseInt(digits || '0', 10);
  return sign === 0xd ? -value : value;
}

export interface AdsimstrRecord { raw: Buffer; ssn: string; conNum: string; }

/** Finds a record by its alternate-key SSN/TIN (pos 32-40, shared by every record type). */
export function findAdsimstrRecordBySsn(buf: Buffer, ssn: string): AdsimstrRecord | null {
  for (const rec of splitAdsimstrRecords(buf)) {
    if (rec.length < 850) continue; // header record, all low-values
    if (ebcdicField(rec, 32, 9) === ssn) {
      return { raw: rec, ssn, conNum: ebcdicField(rec, 5, 6) };
    }
  }
  return null;
}

/** Matches by ALL-CNTR-KEY-CONTRACT (pos 6-10, 5 chars) - the same value as
 * adsi_master.*_record.contract_number - unambiguous even when a firm has
 * both a contract-side and an org-side record sharing the same tax id. */
export function findAdsimstrRecordByContractNumber(buf: Buffer, contractNumber: string): AdsimstrRecord | null {
  for (const rec of splitAdsimstrRecords(buf)) {
    if (rec.length < 850) continue;
    if (ebcdicField(rec, 6, 5) === contractNumber) {
      return { raw: rec, ssn: ebcdicField(rec, 32, 9), conNum: ebcdicField(rec, 5, 6) };
    }
  }
  return null;
}

export const ADSIMSTR_ORG_FAX = {
  countryCode: (rec: Buffer) => ebcdicField(rec, 463, 3),
  areaCode: (rec: Buffer) => ebcdicField(rec, 466, 3),
  number: (rec: Buffer) => ebcdicField(rec, 469, 7),
};

// Fields used by the BRv4 cases in this file - positions copied verbatim from ADSIMSTR.cpy.
export const ADSIMSTR = {
  totNumOfSections: (rec: Buffer) => comp3Field(rec, 849, 2),
  basicMaster: (rec: Buffer, n: number) => comp3Field(rec, 805 + (n - 1) * 4, 2),
  basicOccur: (rec: Buffer, n: number) => comp3Field(rec, 807 + (n - 1) * 4, 2),
};
