// Builds the LNA feed files for the isolated BRv4-uncovered-rules E2E suite.
// Mirrors scripts/make_feeds.py's put()/identity() approach (600-byte fixed-width
// ASCII records, CRLF terminated), but in Node (no working Python in this
// environment) and reserved to generation 99 / a BR-number-keyed sequence so its
// identifiers can never collide with anything the existing reissue_e2e.py
// pipeline has generated for the original 85-feed/284-case suite.
//
// Run once: node scripts/make-feeds-brv4.js
// Writes .txt files into data/feeds/ and a manifest to scripts/feed_index_brv4.json.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FEEDS_DIR = path.join(ROOT, 'data', 'feeds');
const LAYOUT = JSON.parse(fs.readFileSync(path.join(__dirname, 'layout.json'), 'utf8'));
const BASELINE_PATH = path.join(FEEDS_DIR, 'ALLSTATE.LNA.POS-VALID-BASELINE.D20260908.txt');

const CRLF = '\r\n';
const RECLEN = 600;
const FEED_DATE = '20260908';
const GEN = 99; // reserved exclusively for this isolated brv4 suite

const SPAN = {}; // (kind, field) -> [start, end] 1-indexed inclusive
for (const [field, places] of Object.entries(LAYOUT)) {
  for (const [kind, s, e] of places) {
    SPAN[`${kind}\u0000${field}`] = [s, e];
  }
}

function put(rec, span, val) {
  const [s, e] = span;
  const n = e - s + 1;
  const v = String(val);
  if (v.length > n) throw new Error(`value "${v}" (${v.length}) longer than field width ${n}`);
  const out = Buffer.from(rec, 'latin1');
  const padded = Buffer.from(v.padEnd(n, ' '), 'latin1');
  padded.copy(out, s - 1);
  if (out.length !== RECLEN) throw new Error('record length drifted');
  return out.toString('latin1');
}

function setf(rec, kind, field, val) {
  const sp = SPAN[`${kind}\u0000${field}`];
  if (!sp) throw new Error(`field ${field} not in layout for ${kind}`);
  return put(rec, sp, val);
}

// ---------------------------------------------------------------- baseline
const baselineLines = fs.readFileSync(BASELINE_PATH, 'latin1').split(CRLF).filter((l) => l.length > 0);
if (baselineLines.length < 6) throw new Error('baseline feed shorter than expected');
const [A0, B0, C0, D010, D020, Z0] = baselineLines.slice(0, 6);
for (const r of [A0, B0, C0, D010, D020, Z0]) {
  if (r.length !== RECLEN) throw new Error('baseline record not 600 bytes');
}

// ---------------------------------------------------------- identity scheme
// bd  = A + gen(2) + seq(5) + "00"   (10 chars, matches WS-BD-ALLSTATE-ID width)
// tax = gen(2) + (1000000+seq)(7)     (9 chars,  matches WS-TAX-ID-NUM width)
// ssn = gen(2) + (5000000+seq)(7)     (9 chars,  matches WS-SOC-SEC-NUM width)
// pid = P + gen(2) + seq(5) + "00"    (10 chars, matches WS-ALLSTATE-ID width on D02)
function identity(seq) {
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

function buildFirmRecords(seq, overrides = {}) {
  const id = identity(seq);
  let B = B0;
  let C = C0;
  B = setf(B, 'B', 'WS-ALLST-FIRM-NAME', id.firmName);
  B = setf(B, 'B', 'WS-BD-ALLSTATE-ID', id.bd);
  C = setf(C, 'C', 'WS-TAX-ID-NUM', id.tax);
  C = setf(C, 'C', 'WS-FIRM-NAME', id.firmName);
  C = setf(C, 'C', 'WS-ABBR-FIRM-NAME', id.abbrFirmName);
  C = setf(C, 'C', 'WS-ALLSTATE-ID', id.bd);
  C = setf(C, 'C', 'WS-BD-ALLSTATE-ID', id.bd); // C 516-525, "own BD id" copy
  C = setf(C, 'C', 'WS-FIRM-ALLSTATE-ID', id.bd); // C 526-535, firm id = itself (BD is its own firm)
  for (const [field, val] of Object.entries(overrides.C || {})) C = setf(C, 'C', field, val);
  for (const [field, val] of Object.entries(overrides.B || {})) B = setf(B, 'B', field, val);
  return { B, C, id };
}

// A "subsequent firm" (LLE) presented under a valid BD, per make_feeds.py's
// as_subsequent_firm(): its own tax id / name / partner id, entity type LLE,
// firm id is its own, but the copy at C 516-525 keeps the PARENT bd.
function buildSubsequentFirm(seq, parentBd, overrides = {}) {
  const id = identity(seq);
  const lle = `L${String(GEN).padStart(2, '0')}${String(seq).padStart(5, '0')}00`;
  let C = C0;
  C = setf(C, 'C', 'WS-TAX-ID-NUM', id.tax);
  C = setf(C, 'C', 'WS-FIRM-NAME', `E2E BRV4 LLE${String(seq).padStart(5, '0')} LLC`);
  C = setf(C, 'C', 'WS-ABBR-FIRM-NAME', `E2E BRV4 LLE${String(seq).padStart(5, '0')}`);
  C = setf(C, 'C', 'WS-ALLSTATE-ID', lle);
  C = setf(C, 'C', 'WS-ENTITY-TYPE', 'LLE');
  C = setf(C, 'C', 'WS-BD-ALLSTATE-ID', parentBd); // C 516-525, parent BD
  C = setf(C, 'C', 'WS-FIRM-ALLSTATE-ID', lle); // C 526-535, firm id is its own
  for (const [field, val] of Object.entries(overrides.C || {})) C = setf(C, 'C', field, val);
  return { C, lle };
}

function buildProducerPair(seq, bd, firmId, relnStatus, overrides = {}) {
  const id = identity(seq);
  let D1 = D010;
  let D2 = D020;
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

let recordCounter = 0;
function nextSeq(brNumber, tag) {
  // BR number * 100 + a small per-call offset keeps every identity in this
  // suite unique across all 12 rules and every setup/test pair, without ever
  // reaching the 90000+ range the base generation-99 reservation guarantees
  // is untouched by the existing 85-feed pipeline (which never uses gen 99).
  recordCounter += 1;
  return brNumber * 100 + (tag || recordCounter % 97);
}

function assembleFile(fileName, bundles) {
  // bundles: array of arrays of record-strings (each already a full 600-byte record)
  const body = [];
  for (const b of bundles) body.push(...b);
  const total = 1 + body.length;
  let A = A0;
  A = setf(A, 'A', 'WS-COMPANY-NAME', 'ALLSTATE');
  A = setf(A, 'A', 'WS-TRANS-DATE', FEED_DATE);
  A = setf(A, 'A', 'WS-TOT-REC-COUNT', String(total).padStart(12, '0'));
  const recs = [A, ...body];
  for (const r of recs) if (r.length !== RECLEN) throw new Error(`record wrong length in ${fileName}`);
  fs.writeFileSync(path.join(FEEDS_DIR, fileName), recs.join(CRLF) + CRLF, 'latin1');
  return { records: total, bundles: bundles.length };
}

const manifest = {};
function record(fileName, meta) {
  manifest[fileName] = meta;
}

// =====================================================================
// TC-BR-019 - bundle order dependency: valid bundle commits (org+producer),
// a second bundle whose FIRST firm fails validation (entity type outside
// BD/LLE/HA) creates no org and its producer lands in ADBSKIP (reason 002).
// =====================================================================
{
  const seqGood = nextSeq(19, 1);
  const good = buildFirmRecords(seqGood);
  const goodProd = buildProducerPair(nextSeq(19, 2), good.id.bd, good.id.bd, 'A');
  const bundleGood = [good.B, good.C, goodProd.D1, goodProd.D2, Z0];

  const seqBad = nextSeq(19, 3);
  const bad = buildFirmRecords(seqBad, { C: { 'WS-ENTITY-TYPE': 'ZZZ' } });
  const badProd = buildProducerPair(nextSeq(19, 4), bad.id.bd, bad.id.bd, 'A');
  const bundleBad = [bad.B, bad.C, badProd.D1, badProd.D2, Z0];

  const fn = 'ALLSTATE.LNA.BR-019.D20260908.txt';
  const info = assembleFile(fn, [bundleGood, bundleBad]);
  record(fn, {
    ...info,
    rule: 'BR-019',
    bundleGoodBd: good.id.bd,
    bundleBadBd: bad.id.bd,
    badProducerSsn: badProd.id.ssn,
    goodProducerSsn: goodProd.id.ssn,
  });
}

// =====================================================================
// TC-BR-125 - bundle atomicity: one bundle carries a B0601-style fault
// (reserved tax id 111111111 on the BD's own firm record) with TWO producer
// pairs beneath it - the whole bundle, including both producers, must be
// withdrawn as one indivisible unit. A second, wholly valid control bundle
// proves the failure did not spill over.
// =====================================================================
{
  const seqBad = nextSeq(125, 1);
  const bad = buildFirmRecords(seqBad, { C: { 'WS-TAX-ID-NUM': '111111111' } });
  const prod1 = buildProducerPair(nextSeq(125, 2), bad.id.bd, bad.id.bd, 'A');
  const prod2 = buildProducerPair(nextSeq(125, 3), bad.id.bd, bad.id.bd, 'A');
  const bundleBad = [bad.B, bad.C, prod1.D1, prod1.D2, prod2.D1, prod2.D2, Z0];

  const seqGood = nextSeq(125, 4);
  const good = buildFirmRecords(seqGood);
  const goodProd = buildProducerPair(nextSeq(125, 5), good.id.bd, good.id.bd, 'A');
  const bundleGood = [good.B, good.C, goodProd.D1, goodProd.D2, Z0];

  const fn = 'ALLSTATE.LNA.BR-125.D20260908.txt';
  const info = assembleFile(fn, [bundleBad, bundleGood]);
  record(fn, {
    ...info,
    rule: 'BR-125',
    badBundleBd: bad.id.bd,
    badBundleProducerSsns: [prod1.id.ssn, prod2.id.ssn],
    controlBundleBd: good.id.bd,
    controlProducerSsn: goodProd.id.ssn,
  });
}

// =====================================================================
// TC-BR-126 - standalone (non-bundled) records: one bare firm (C) record
// with no B/D wrapper, and one bare producer (D01) record with no B/C/D02
// wrapper, each its own indivisible unit. One good, one faulted (blank
// last name, D0103-style), to show one committed and one leaves no rows.
// =====================================================================
{
  const seqGoodFirm = nextSeq(126, 1);
  const goodFirm = buildFirmRecords(seqGoodFirm);
  const seqBadProd = nextSeq(126, 2);
  const badProdId = identity(seqBadProd);
  let badD01 = D010;
  badD01 = setf(badD01, 'D01', 'WS-SOC-SEC-NUM', badProdId.ssn);
  badD01 = setf(badD01, 'D01', 'WS-LAST-NAME', ''); // D0103: last name blank

  const fn = 'ALLSTATE.LNA.BR-126.D20260908.txt';
  // Standalone records are presented bare, each between the shared header/trailer.
  const info = assembleFile(fn, [[goodFirm.C], [badD01]]);
  record(fn, {
    ...info,
    rule: 'BR-126',
    standaloneGoodFirmId: goodFirm.id.bd,
    standaloneBadProducerSsn: badProdId.ssn,
  });
}

// =====================================================================
// TC-BR-127 - per-record failure vs run-fatal: one bad producer (D0102,
// blank first name) inside an otherwise valid, multi-producer bundle - the
// bad producer is rejected on its own, the rest of the bundle (and the run)
// still completes normally.
// =====================================================================
{
  const seq = nextSeq(127, 1);
  const firm = buildFirmRecords(seq);
  const goodProd = buildProducerPair(nextSeq(127, 2), firm.id.bd, firm.id.bd, 'A');
  const badProdSeq = nextSeq(127, 3);
  const badProdId = identity(badProdSeq);
  let badD01 = D010;
  badD01 = setf(badD01, 'D01', 'WS-SOC-SEC-NUM', badProdId.ssn);
  badD01 = setf(badD01, 'D01', 'WS-FIRST-NAME', ''); // D0102: first name blank
  let badD02 = D020;
  badD02 = setf(badD02, 'D02', 'WS-SOC-SEC-NUM', badProdId.ssn);
  badD02 = setf(badD02, 'D02', 'WS-ALLSTATE-ID', badProdId.pid);
  badD02 = setf(badD02, 'D02', 'WS-FIRM-ALLSTATE-ID', firm.id.bd);
  badD02 = setf(badD02, 'D02', 'WS-BD-ALLSTATE-ID', firm.id.bd);
  badD02 = setf(badD02, 'D02', 'WS-RELN-STATUS', 'A');
  badD02 = setf(badD02, 'D02', 'WS-RELN-START-DT', '20260101');
  badD02 = setf(badD02, 'D02', 'WS-RELN-END-DT', '99999999');

  const fn = 'ALLSTATE.LNA.BR-127.D20260908.txt';
  const info = assembleFile(fn, [[firm.B, firm.C, goodProd.D1, goodProd.D2, badD01, badD02, Z0]]);
  record(fn, {
    ...info,
    rule: 'BR-127',
    bundleBd: firm.id.bd,
    goodProducerSsn: goodProd.id.ssn,
    badProducerSsn: badProdId.ssn,
  });
}

// =====================================================================
// TC-BR-128 - three distinguishable outcomes in one cycle:
//  (a) a record refused on its own merits (D0101-style bad SSN on a producer)
//  (b) that producer's own D02 consequently skipped (not its own fault)
//  (c) a separate bundle refused wholesale on its own merits (B0601 fault),
//      landing in LNAERROR only, never ADBSKIP - kept distinct from (a)/(b).
// =====================================================================
{
  const seq = nextSeq(128, 1);
  const firm = buildFirmRecords(seq);
  const goodProd = buildProducerPair(nextSeq(128, 2), firm.id.bd, firm.id.bd, 'A');
  const badSeq = nextSeq(128, 3);
  const badId = identity(badSeq);
  let badD01 = D010;
  badD01 = setf(badD01, 'D01', 'WS-SOC-SEC-NUM', '000000000'); // D0101-style: not 9 numeric-meaningful positions
  let badD02 = D020;
  badD02 = setf(badD02, 'D02', 'WS-SOC-SEC-NUM', '000000000');
  badD02 = setf(badD02, 'D02', 'WS-ALLSTATE-ID', badId.pid);
  badD02 = setf(badD02, 'D02', 'WS-FIRM-ALLSTATE-ID', firm.id.bd);
  badD02 = setf(badD02, 'D02', 'WS-BD-ALLSTATE-ID', firm.id.bd);
  badD02 = setf(badD02, 'D02', 'WS-RELN-STATUS', 'A');
  badD02 = setf(badD02, 'D02', 'WS-RELN-START-DT', '20260101');
  badD02 = setf(badD02, 'D02', 'WS-RELN-END-DT', '99999999');
  const bundle1 = [firm.B, firm.C, goodProd.D1, goodProd.D2, badD01, badD02, Z0];

  const seqBundle2 = nextSeq(128, 4);
  const bundle2Firm = buildFirmRecords(seqBundle2, { C: { 'WS-TAX-ID-NUM': '111111111' } });
  const bundle2 = [bundle2Firm.B, bundle2Firm.C, Z0];

  const fn = 'ALLSTATE.LNA.BR-128.D20260908.txt';
  const info = assembleFile(fn, [bundle1, bundle2]);
  record(fn, {
    ...info,
    rule: 'BR-128',
    bundle1Bd: firm.id.bd,
    ownMeritsProducerSsn: '000000000',
    consequentialSkipNote: 'same producer position, D02 skipped as a consequence of its own D01 failing, not independently rejected',
    bundle2WholesaleBd: bundle2Firm.id.bd,
  });
}

// =====================================================================
// TC-BR-256 - existing contract routes to UPDATE. Two-step: setup feed
// creates the BD, test feed resubmits the SAME identity unchanged.
// =====================================================================
{
  const seq = nextSeq(256, 1);
  const setup = buildFirmRecords(seq);
  const setupProd = buildProducerPair(nextSeq(256, 2), setup.id.bd, setup.id.bd, 'A');
  const setupFn = 'ALLSTATE.LNA.BR-256-SETUP.D20260908.txt';
  const setupInfo = assembleFile(setupFn, [[setup.B, setup.C, setupProd.D1, setupProd.D2, Z0]]);
  record(setupFn, { ...setupInfo, rule: 'BR-256', role: 'setup', bd: setup.id.bd });

  const test = buildFirmRecords(seq); // identical identity -> same BD resubmitted
  const testProd = buildProducerPair(nextSeq(256, 2), test.id.bd, test.id.bd, 'A'); // same producer identity too
  const testFn = 'ALLSTATE.LNA.BR-256-TEST.D20260908.txt';
  const testInfo = assembleFile(testFn, [[test.B, test.C, testProd.D1, testProd.D2, Z0]]);
  record(testFn, { ...testInfo, rule: 'BR-256', role: 'test', bd: test.id.bd });
}

// =====================================================================
// TC-BR-257 - no existing contract -> routes to CREATE. Single fresh BD.
// =====================================================================
{
  const seq = nextSeq(257, 1);
  const firm = buildFirmRecords(seq);
  const prod = buildProducerPair(nextSeq(257, 2), firm.id.bd, firm.id.bd, 'A');
  const fn = 'ALLSTATE.LNA.BR-257.D20260908.txt';
  const info = assembleFile(fn, [[firm.B, firm.C, prod.D1, prod.D2, Z0]]);
  record(fn, { ...info, rule: 'BR-257', bd: firm.id.bd });
}

// =====================================================================
// TC-BR-261 - no existing parent relationship -> routes to CREATE.
// Single fresh BD (a brand-new organisation has no prior relationship row).
// =====================================================================
{
  const seq = nextSeq(261, 1);
  const firm = buildFirmRecords(seq);
  const prod = buildProducerPair(nextSeq(261, 2), firm.id.bd, firm.id.bd, 'A');
  const fn = 'ALLSTATE.LNA.BR-261.D20260908.txt';
  const info = assembleFile(fn, [[firm.B, firm.C, prod.D1, prod.D2, Z0]]);
  record(fn, { ...info, rule: 'BR-261', bd: firm.id.bd });
}

// =====================================================================
// TC-BR-269 - firm name change on an existing BD is staged and updated.
// Two-step: setup feed with name X, test feed same BD with name Y.
// =====================================================================
{
  const seq = nextSeq(269, 1);
  const nameX = `E2E BRV4 OLDNAME${String(seq).padStart(5, '0')} LLC`;
  const nameY = `E2E BRV4 NEWNAME${String(seq).padStart(5, '0')} LLC`;

  const setup = buildFirmRecords(seq, { C: { 'WS-FIRM-NAME': nameX } });
  const setupProd = buildProducerPair(nextSeq(269, 2), setup.id.bd, setup.id.bd, 'A');
  const setupFn = 'ALLSTATE.LNA.BR-269-SETUP.D20260908.txt';
  const setupInfo = assembleFile(setupFn, [[setup.B, setup.C, setupProd.D1, setupProd.D2, Z0]]);
  record(setupFn, { ...setupInfo, rule: 'BR-269', role: 'setup', bd: setup.id.bd, firmName: nameX });

  const test = buildFirmRecords(seq, { C: { 'WS-FIRM-NAME': nameY } });
  const testProd = buildProducerPair(nextSeq(269, 2), test.id.bd, test.id.bd, 'A');
  const testFn = 'ALLSTATE.LNA.BR-269-TEST.D20260908.txt';
  const testInfo = assembleFile(testFn, [[test.B, test.C, testProd.D1, testProd.D2, Z0]]);
  record(testFn, { ...testInfo, rule: 'BR-269', role: 'test', bd: test.id.bd, firmName: nameY });
}

// =====================================================================
// TC-BR-273 - organisation service reports success on creation/amendment.
// A plain, wholly valid new-BD bundle - CREATED counter should move.
// =====================================================================
{
  const seq = nextSeq(273, 1);
  const firm = buildFirmRecords(seq);
  const prod = buildProducerPair(nextSeq(273, 2), firm.id.bd, firm.id.bd, 'A');
  const fn = 'ALLSTATE.LNA.BR-273.D20260908.txt';
  const info = assembleFile(fn, [[firm.B, firm.C, prod.D1, prod.D2, Z0]]);
  record(fn, { ...info, rule: 'BR-273', bd: firm.id.bd });
}

// =====================================================================
// TC-BR-304 - relationship status change is recorded as the kind of event
// it represents (reactivation / termination). Two-step: setup feed puts
// producer1 at status T (terminated) and producer2 at status A (active);
// test feed resubmits the SAME two producers with status FLIPPED
// (producer1 -> A = reactivation, producer2 -> T = termination).
// =====================================================================
{
  const seqFirm = nextSeq(304, 1);
  const setupFirm = buildFirmRecords(seqFirm);
  const seqP1 = nextSeq(304, 2);
  const seqP2 = nextSeq(304, 3);
  const setupP1 = buildProducerPair(seqP1, setupFirm.id.bd, setupFirm.id.bd, 'T');
  const setupP2 = buildProducerPair(seqP2, setupFirm.id.bd, setupFirm.id.bd, 'A');
  const setupFn = 'ALLSTATE.LNA.BR-304-SETUP.D20260908.txt';
  const setupInfo = assembleFile(setupFn, [[setupFirm.B, setupFirm.C, setupP1.D1, setupP1.D2, setupP2.D1, setupP2.D2, Z0]]);
  record(setupFn, {
    ...setupInfo,
    rule: 'BR-304',
    role: 'setup',
    bd: setupFirm.id.bd,
    reactivationProducerSsn: setupP1.id.ssn,
    terminationProducerSsn: setupP2.id.ssn,
  });

  const testFirm = buildFirmRecords(seqFirm); // same BD identity
  const testP1 = buildProducerPair(seqP1, testFirm.id.bd, testFirm.id.bd, 'A'); // T -> A: reactivation
  const testP2 = buildProducerPair(seqP2, testFirm.id.bd, testFirm.id.bd, 'T'); // A -> T: termination
  const testFn = 'ALLSTATE.LNA.BR-304-TEST.D20260908.txt';
  const testInfo = assembleFile(testFn, [[testFirm.B, testFirm.C, testP1.D1, testP1.D2, testP2.D1, testP2.D2, Z0]]);
  record(testFn, {
    ...testInfo,
    rule: 'BR-304',
    role: 'test',
    bd: testFirm.id.bd,
    reactivationProducerSsn: testP1.id.ssn,
    terminationProducerSsn: testP2.id.ssn,
  });
}

// =====================================================================
// TC-BR-369 - appointment service reports success and returns the enriched
// output record. A plain valid producer under a valid BD; the enriched row
// (with office/org fields resolved) should reach LOADFILE.
// =====================================================================
{
  const seq = nextSeq(369, 1);
  const firm = buildFirmRecords(seq);
  const prod = buildProducerPair(nextSeq(369, 2), firm.id.bd, firm.id.bd, 'A');
  const fn = 'ALLSTATE.LNA.BR-369.D20260908.txt';
  const info = assembleFile(fn, [[firm.B, firm.C, prod.D1, prod.D2, Z0]]);
  record(fn, { ...info, rule: 'BR-369', bd: firm.id.bd, producerSsn: prod.id.ssn, producerPid: prod.id.pid });
}

fs.writeFileSync(
  path.join(__dirname, 'feed_index_brv4.json'),
  JSON.stringify(manifest, null, 2),
);

console.log('Wrote', Object.keys(manifest).length, 'feed files into', FEEDS_DIR);
console.log('Manifest: scripts/feed_index_brv4.json');
