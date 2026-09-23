# -*- coding: utf-8 -*-
"""Render the destination-driven and positive E2E specs into LNA feed files.

Companion to make_feeds.py, which covered the 58 ERR_* specs only. This covers
the 9 DEST_* specs whose destination produces an inspectable artefact, plus
POS_VALID_BASELINE. DEST_JAVA_EXCEPTION and DEST_LOG_ONLY are deliberately not
rendered: neither produces anything downloadable, so a feed file for them could
never return a verdict.

Same format as the merged demo file: 600-byte fixed-width records, CRLF, one
submitting header (A) then one bundle (B, C, D01, D02, Z) per business rule,
each bundle carrying its own firm, broker dealer and producer identity.
"""
import os, re, json, glob, collections
import openpyxl

ROOT = r"C:\Users\RSERRANO\PRU ADB"
SPECDIR = os.path.join(ROOT, "Test Data Scenarios for Demo", "PRU_ADB_E2E_Test_Data_v4")
SAMPLE = os.path.join(ROOT, "Test Data Scenarios for Demo", "006_Merged File",
                      "ALLSTATE.LNA.DEMO-MERGED-BR031-035.D20260908.txt")
OUTDIR = os.path.join(ROOT, "E2E Test Data")
CRLF, RECLEN, FEED_DATE = b"\r\n", 600, "20260908"

NOT_RENDERED = {"DEST_JAVA_EXCEPTION": "A Java exception produces no downloadable artefact. There is "
                                       "nothing to assert against, so no feed file is generated.",
                "DEST_LOG_ONLY": "The outcome is written to the application log only. The log is not among "
                                 "the General Artifacts, so no feed file is generated."}

LAYOUT = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "layout.json")))
SPAN = {}
for fld, places in LAYOUT.items():
    for kind, s, e in places:
        SPAN[(kind, fld)] = (s, e)

src = [x for x in open(SAMPLE, "rb").read().split(CRLF) if x]
A0, B0, C0, D010, D020, Z0 = src[0], src[1], src[2], src[3], src[4], src[5]


def put(rec, span, val):
    s, e = span
    n = e - s + 1
    v = str(val).encode("latin-1")
    assert len(v) <= n, (val, n)
    out = bytearray(rec)
    out[s - 1:e] = v.ljust(n)
    return bytes(out)


GEN = int(os.environ.get("E2E_GENERATION", "0"))
SEQ = [50000]       # offset keeps these clear of the error-code feeds' counter


def identity(recs):
    """Own firm, broker dealer and producer per bundle, unique across the whole
    set and stamped with the generation. See make_feeds.py for why."""
    SEQ[0] += 1
    n = SEQ[0]
    bd = "A%02d%05d00" % (GEN, n)
    tax = "%02d%07d" % (GEN, 1000000 + n)
    ssn = "%02d%07d" % (GEN, 5000000 + n)
    pid = "P%02d%05d00" % (GEN, n)
    firm = "E2E G%02d B%05d LLC" % (GEN, n)
    B, C, D1, D2, Z = recs
    B = put(B, (2, 51), firm); B = put(B, (54, 63), bd)
    C = put(C, (2, 10), tax); C = put(C, (11, 60), firm)
    for s, e in [(88, 97), (516, 525), (526, 535)]:
        C = put(C, (s, e), bd)
    D1 = put(D1, (4, 12), ssn)
    D2 = put(D2, (4, 12), ssn); D2 = put(D2, (14, 23), pid)
    for s, e in [(241, 250), (251, 260)]:
        D2 = put(D2, (s, e), bd)
    return [B, C, D1, D2, Z], dict(bd=bd, tax=tax, firm=firm)


# --------------------------------------------------- faults taken from the BRD trigger text
# Only where the rule names a field that exists in the feed layout AND its own
# trigger states the condition plainly enough to set a value without inventing one.
FAULT = {
    "BR-290": ("C", "WS-ENTITY-TYPE", "ZZZ",
               "entity type outside BD / LLE / HA, so firm routing has nothing to route to"),
    "BR-291": ("C", "WS-FIRM-NAME", "",
               "mandatory firm name left spaces on a BD firm entity"),
    "BR-292": ("C", "WS-FIRM-NAME", "",
               "mandatory firm name left spaces on an LLE firm entity"),
    "BR-293": ("C", "WS-FIRM-NAME", "",
               "mandatory firm name left spaces on a house-account firm entity"),
    "BR-294": ("D01", "WS-FIRST-NAME", "",
               "mandatory first name left spaces on the producer entity"),
}
ENTITY = {"BR-291": "BD", "BR-292": "LLE", "BR-293": "HA"}

# Conditions that live on the submitting header. A header is shared by every bundle
# in the file, so forcing one here would corrupt all the other records. Flagged, not forced.
HEADER_LEVEL = {
    "BR-002": "the first record of the file must not be a submitting header",
    "BR-164": "the first record read must be type A",
    "BR-168": "one of the three header controls (name, date, count) must fail",
}
# Conditions that depend on what is already committed in ADB, not on file content.
PRECONDITION = {
    "BR-207": "the parent broker dealer contract must already exist in UTT_ALL_CNTR",
    "BR-208": "the firm must already be an LLE child of the BD node in UTT_ALL_NODE_REL",
}
POSITIVE = {"BR-003": "a normal run in which all three header controls match; the outcome is the "
                      "control report itself, not an error"}

# --------------------------------------------------------------------- build
MAN, STATS = [], collections.Counter()

specs = [p for p in sorted(glob.glob(os.path.join(SPECDIR, "DEST_*.xlsx")))
         if os.path.basename(p)[:-5] not in NOT_RENDERED]
specs += [os.path.join(SPECDIR, "POS_VALID_BASELINE.xlsx")]

for p in specs:
    name = os.path.basename(p)[:-5]
    ws = openpyxl.load_workbook(p, data_only=True).worksheets[0]
    positive = name.startswith("POS")
    dest = "" if positive else str(ws.cell(1, 1).value).split("destination", 1)[-1].strip()

    body, notes = [], []
    for r in range(4, ws.max_row + 1):
        if not ws.cell(r, 1).value:
            continue
        br = str(ws.cell(r, 2).value).strip()
        fields = str(ws.cell(r, 5).value or "")
        bundle, ident = identity([B0, C0, D010, D020, Z0])
        B, C, D1, D2, Z = bundle

        if positive:
            applied, cls = "all fields valid; no rule violated", "positive"
        elif br in FAULT:
            kind, fld, val, note = FAULT[br]
            sp = SPAN.get((kind, fld))
            tgt = {"B": B, "C": C, "D01": D1, "D02": D2}[kind]
            tgt = put(tgt, sp, val)
            if br in ENTITY:
                tgt = put(tgt, SPAN[("C", "WS-ENTITY-TYPE")], ENTITY[br])
            if kind == "C": C = tgt
            elif kind == "D01": D1 = tgt
            elif kind == "B": B = tgt
            else: D2 = tgt
            applied = "%s.%s = %s (%s)" % (kind, fld, repr(val), note)
            cls = "fault injected"
        elif br in HEADER_LEVEL:
            applied = "HEADER-LEVEL: " + HEADER_LEVEL[br] + \
                      " - not forced here; this condition needs a file of its own"
            cls = "header-level"
        elif br in PRECONDITION:
            applied = "PRECONDITION: " + PRECONDITION[br] + " - not forceable from file content"
            cls = "precondition"
        elif br in POSITIVE:
            applied = "BY DESIGN: " + POSITIVE[br]
            cls = "positive"
        else:
            applied = ("CARRIER: the rule's fields (%s) are internal working storage or service-layer "
                       "values with no position in the feed layout. The bundle is valid and isolated; "
                       "the rule is observed at %s, not forced from the file."
                       % (fields[:70] + ("..." if len(fields) > 70 else ""), dest or "the output"))
            cls = "carrier - not drivable from the feed"

        body += [B, C, D1, D2, Z]
        notes.append((br, cls, applied, ident["bd"]))
        STATS[cls] += 1

    total = 1 + len(body)
    A = put(A0, (102, 109), FEED_DATE)
    A = put(A, (110, 121), str(total).rjust(12, "0"))
    recs = [A] + body
    for x in recs:
        assert len(x) == RECLEN, len(x)

    tag = name.replace("DEST_", "DEST-").replace("POS_", "POS-").replace("_", "-")
    fn = "ALLSTATE.LNA.%s.D%s.txt" % (tag, FEED_DATE)
    open(os.path.join(OUTDIR, fn), "wb").write(CRLF.join(recs) + CRLF)
    MAN.append(dict(file=fn, spec=name, dest=dest, records=total, bundles=len(notes), notes=notes))

# ------------------------------------------------------------------ manifest
L = []
L.append("PRU ADB - E2E TEST DATA, DESTINATION-DRIVEN AND POSITIVE FEEDS (BRD v4)")
L.append("=" * 100)
L.append("")
L.append("Companion to _MANIFEST.txt, which covers the 58 ALLSTATE.LNA.<error code> files.")
L.append("Those cover the 80 rules that raise an error code. These cover the rules that have no")
L.append("error code and are judged by WHERE their output lands, plus the positive baseline.")
L.append("")
L.append("Format is identical: 600-byte fixed-width records, CRLF, one submitting header (A)")
L.append("then one bundle (B, C, D01, D02, Z) per business rule. Identifiers use the A91 band")
L.append("so they cannot collide with the A90 band used by the error-code files.")
L.append("")
L.append("Feed Date for every file: %s (carried on the submitting header)." % FEED_DATE)
L.append("")
L.append("-" * 100)
L.append("READ THIS BEFORE EXECUTING")
L.append("-" * 100)
L.append("")
L.append("These rules name no error code, so the LNA report cannot confirm them by code match.")
L.append("Each record below carries one of five classifications:")
L.append("")
L.append("  fault injected   The rule names a field that exists in the feed layout and its own")
L.append("                   trigger states the condition plainly. The fault is in the file and")
L.append("                   the expected destination should be reached.")
L.append("  positive         The expected outcome is success, not an error.")
L.append("  carrier          The rule's fields are internal working storage or service-layer")
L.append("                   values with no position in the feed layout. The bundle is valid and")
L.append("                   isolated, but the condition is NOT forced by the file. Uploading it")
L.append("                   will not by itself produce output at the expected destination.")
L.append("                   Record the test case as BLOCKED - data not drivable from the feed.")
L.append("                   Do not record it as a failure of the application.")
L.append("  header-level     The condition sits on the submitting header, which every bundle in")
L.append("                   the file shares. Forcing it would corrupt every other record, so it")
L.append("                   needs a single-rule file of its own. Not yet built.")
L.append("  precondition     The condition depends on what is already committed in ADB, not on")
L.append("                   file content. Set the state first, then execute.")
L.append("")
L.append("Not rendered, deliberately:")
for k, v in NOT_RENDERED.items():
    L.append("  %-22s %s" % (k, v))
L.append("")
L.append("=" * 100)
for m in MAN:
    L.append("")
    L.append(m["file"])
    L.append("  from spec   : %s.xlsx" % m["spec"])
    if m["dest"]:
        L.append("  destination : %s" % m["dest"])
    L.append("  records     : %d  (1 header + %d bundle record(s))" % (m["records"], m["records"] - 1))
    L.append("  bundles     : %d, one per business rule" % m["bundles"])
    c = collections.Counter(n[1] for n in m["notes"])
    L.append("  breakdown   : %s" % ", ".join("%s %d" % (k, v) for k, v in c.most_common()))
    for i, (br, cls, applied, bd) in enumerate(m["notes"], 1):
        L.append("     bundle %-3d %-8s bd=%s  [%s]" % (i, br, bd, cls))
        L.append("                %s" % applied)
open(os.path.join(OUTDIR, "_MANIFEST_DESTINATION.txt"), "w", encoding="utf-8").write("\n".join(L) + "\n")

print("output folder :", OUTDIR)
print("files written :", len(MAN))
print("total records :", sum(m["records"] for m in MAN))
print("bundles       :", sum(m["bundles"] for m in MAN))
print()
for k, v in STATS.most_common():
    print("   %-38s %3d" % (k, v))

json.dump({m["spec"]: dict(file=m["file"],
                           rules={n[0]: dict(cls=n[1], note=n[2], bd=n[3]) for n in m["notes"]})
           for m in MAN}, open("dest_feed_map.json", "w"), indent=1)
print("\nwrote dest_feed_map.json")

IDX = {}
for m in MAN:
    pos, bundles = 2, []
    for i, (br, cls, applied, bd) in enumerate(m["notes"], 1):
        bundles.append(dict(index=i, br=br, recordStart=pos, recordCount=5, note=applied, cls=cls, bd=bd))
        pos += 5
    IDX[m["file"]] = dict(code="", description="", records=m["records"],
                          family="positive" if m["spec"].startswith("POS") else "destination",
                          destination=m["dest"], spec=m["spec"], bundles=bundles)
json.dump(IDX, open("feed_index_dest.json", "w"), indent=1)
print("wrote feed_index_dest.json")
