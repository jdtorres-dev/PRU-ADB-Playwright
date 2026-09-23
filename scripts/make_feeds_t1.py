# -*- coding: utf-8 -*-
"""Feed files for the rules recovered from the Java destination column.

Eight conditions that can be built into a feed file (T1) and three that live on
the submitting header and so need a file each (T1H). Expected results come from
Destination Detail (Java), never from the COBOL columns.
"""
import json
import os

ROOT = r"C:\Users\RSERRANO\PRU ADB"
HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE = os.path.join(ROOT, "Test Data Scenarios for Demo", "006_Merged File",
                      "ALLSTATE.LNA.DEMO-MERGED-BR031-035.D20260908.txt")
OUTDIR = os.path.join(ROOT, "E2E Test Data")
CRLF, RECLEN, FEED_DATE = b"\r\n", 600, "20260908"
GEN = int(os.environ.get("E2E_GENERATION", "0"))

src = [x for x in open(SAMPLE, "rb").read().split(CRLF) if x]
A0, B0, C0, D010, D020, Z0 = src[0], src[1], src[2], src[3], src[4], src[5]

SEQ = [80000]           # clear of the error-code (0+) and destination (50000+) bands


def put(rec, s, e, val):
    n = e - s + 1
    v = str(val).encode("latin-1")
    assert len(v) <= n, (val, n)
    out = bytearray(rec)
    out[s - 1:e] = v.ljust(n)
    return bytes(out)


def bundle():
    SEQ[0] += 1
    n = SEQ[0]
    bd, tax, ssn, pid = ("A%02d%05d00" % (GEN, n), "%02d%07d" % (GEN, 1000000 + n),
                         "%02d%07d" % (GEN, 5000000 + n), "P%02d%05d00" % (GEN, n))
    firm = "E2E G%02d B%05d LLC" % (GEN, n)
    B = put(put(B0, 2, 51, firm), 54, 63, bd)
    C = put(put(C0, 2, 10, tax), 11, 60, firm)
    for s, e in ((88, 97), (516, 525), (526, 535)):
        C = put(C, s, e, bd)
    D1 = put(D010, 4, 12, ssn)
    D2 = put(put(D020, 4, 12, ssn), 14, 23, pid)
    for s, e in ((241, 250), (251, 260)):
        D2 = put(D2, s, e, bd)
    return B, C, D1, D2, Z0, dict(bd=bd, tax=tax, firm=firm, ssn=ssn)


def header(total, company=None, trans=None, count=None):
    A = put(A0, 102, 109, trans or FEED_DATE)
    A = put(A, 110, 121, str(count if count is not None else total).rjust(12, "0"))
    if company:
        A = put(A, 2, 101, company)
    return A


def write(name, recs, meta):
    for r in recs:
        assert len(r) == RECLEN, len(r)
    fn = "ALLSTATE.LNA.%s.D%s.txt" % (name, FEED_DATE)
    open(os.path.join(OUTDIR, fn), "wb").write(CRLF.join(recs) + CRLF)
    meta["file"] = fn
    meta["records"] = len(recs)
    return meta


MAN = []

# ---------------------------------------------------------------- T1 bundles
body, notes = [], []


# The expected result for these two is an activity marker on the extract. The
# validator reads the LNA report, the control report and the load output; it
# cannot yet assert on ADSIMSTR, so they must not be reported as executable.
MARKER_ONLY = {"BR-038", "BR-057"}


def add(rule, recs, note, ident):
    """One bundle per rule, each with its own identity so they cannot interfere."""
    start = 2 + len(body)
    body.extend(recs)
    notes.append(dict(br=rule, recordStart=start, recordCount=len(recs), note=note,
                      bd=ident["bd"],
                      cls=("marker on the extract - the validator cannot assert on ADSIMSTR yet"
                           if rule in MARKER_ONLY else "fault injected")))


# BR-009 - producer record with an unrecognised sub-type
B, C, D1, D2, Z, ident = bundle()
add("BR-009", [B, C, put(D1, 2, 3, "03"), D2, Z],
    "D01 record sub-type set to 03; the two recognised values are 01 and 02", ident)

# BR-169 - a record type outside B / C / D01 / D02 / Z
B, C, D1, D2, Z, ident = bundle()
add("BR-169", [B, C, D1, D2, put(D2, 1, 3, "X99"), Z],
    "an extra record whose type is X99, outside the five recognised types", ident)

# BR-172 - a producer entity record where the profile belongs
B, C, D1, D2, Z, ident = bundle()
add("BR-172", [B, C, D1, D1, Z],
    "the D01 repeated in the D02 position, so a profile is expected but an entity arrives", ident)

# BR-015 - a refused contra header suppresses everything beneath it
B, C, D1, D2, Z, ident = bundle()
add("BR-015", [put(B, 2, 51, ""), C, D1, D2, Z],
    "contra header firm name blanked (a known refusal); C, D01 and D02 follow normally and must "
    "all be drained to ADBSKIP under reason 002", ident)

# BR-309 - profile type H where no relationship can exist
B, C, D1, D2, Z, ident = bundle()
add("BR-309", [B, C, D1, put(D2, 13, 13, "H"), Z],
    "profile type H on identifiers never presented before, so no investment professional "
    "relationship exists for them to amend", ident)

# BR-038 and BR-057 - a wholly valid bundle; the outcome is the activity marker
B, C, D1, D2, Z, ident = bundle()
add("BR-038", [B, C, D1, D2, Z],
    "a valid bundle creating a new organisation; expect an ORO0OR activity entry, not an error",
    ident)
B, C, D1, D2, Z, ident = bundle()
add("BR-057", [B, C, D1, D2, Z],
    "a valid bundle presenting a producer for appointment; expect an AP00AP marker", ident)

recs = [header(1 + len(body))] + body
MAN.append(write("T1-JAVA-RECOVERED", recs,
                 dict(kind="T1", rules=[n["br"] for n in notes], bundles=notes,
                      summary="Eight conditions recovered by reading Destination Detail (Java).")))

# ------------------------------------- BR-047 needs its own file
# Its bundle deliberately omits the firm entity. That raises B0400 and drains every
# record to the next contra header, which corrupted the bundle that followed it when
# the two shared a file.
# Omitting the firm entity raises B0400 before the rule is reached, so the firm
# entity stays. What makes the profile out of sequence is that it arrives with no
# producer entity before it.
B, C, D1, D2, Z, ident = bundle()
b47 = [B, C, D2, Z]
MAN.append(write("T1-BR047-PROFILE-OUT-OF-SEQUENCE", [header(1 + len(b47))] + b47,
                 dict(kind="T1", rules=["BR-047"],
                      bundles=[dict(br="BR-047", recordStart=2, recordCount=4, bd=ident["bd"],
                                    cls="fault injected",
                                    note="the firm entity is present and valid; the D02 follows it with no "
                                         "producer entity in between, so a profile arrives out of sequence")],
                      summary="Single-rule file: a profile record out of sequence. Isolated because "
                              "its refusal drains the records that follow.")))

# ---------------------------------------------------- T1H one file per header rule
HEADERS = [
    ("BR-002", "HDR-BR002-NOT-HEADER", dict(first="C"),
     "the file does not begin with a submitting header - the first record is a firm entity"),
    ("BR-164", "HDR-BR164-FIRST-NOT-A", dict(first="B"),
     "the first record read is a contra header, not record type A"),
    ("BR-168", "HDR-BR168-CONTROL-FAILS", dict(count=888),
     "one of the three header controls fails, which must stop the run. Overlaps BR-167; the "
     "duplicate check flags these two against each other"),
    ("BR-165", "HDR-BR165-COMPANY", dict(company="NOT THE EXPECTED PARTNER NAME"),
     "company name on the submitting header does not match the name supplied to the job"),
    ("BR-166", "HDR-BR166-TRANSDATE", dict(trans="20250101"),
     "transmission date on the header does not equal the cycle date (Feed Date) set in the console"),
    ("BR-167", "HDR-BR167-RECCOUNT", dict(count=999),
     "record count declared on the header does not match the number of records present"),
]
for rule, tag, kw, note in HEADERS:
    B, C, D1, D2, Z, ident = bundle()
    b2 = [B, C, D1, D2, Z]
    first = kw.pop("first", None)
    A = header(1 + len(b2), **kw)
    recs = [A] + b2
    if first:
        # the condition is that the file does NOT open with a submitting header,
        # so the header is dropped and the named record type leads instead
        recs = ([C] + b2) if first == "C" else b2
    MAN.append(write(tag, recs,
                     dict(kind="T1H", rules=[rule],
                          bundles=[dict(br=rule, recordStart=1 if first else 2, recordCount=5,
                                        note=note, bd=ident["bd"],
                                        cls="header fault injected")],
                          summary="Single-rule file: " + note)))

json.dump({m["file"]: dict(code="", description="", records=m["records"], family="java-recovered",
                           destination="", bundles=[dict(index=i + 1, **b) for i, b in
                                                    enumerate(m["bundles"])])
           for m in MAN}, open(os.path.join(HERE, "feed_index_t1.json"), "w"), indent=1)

lines = ["PRU ADB - E2E TEST DATA RECOVERED FROM DESTINATION DETAIL (JAVA)", "=" * 100, "",
         "These conditions were classed 'not drivable from the feed' while the specifications took",
         "their fields from the COBOL columns. Read against Destination Detail (Java), which",
         "describes the modernised behaviour, each one can be built after all.", "",
         "Feed Date for every file: %s. Generation: %02d." % (FEED_DATE, GEN), "", "=" * 100]
for m in MAN:
    lines += ["", m["file"], "  kind      : %s" % m["kind"], "  records   : %d" % m["records"],
              "  %s" % m["summary"]]
    for i, b in enumerate(m["bundles"], 1):
        lines.append("     bundle %-2d %-8s records %d-%d  bd=%s"
                     % (i, b["br"], b["recordStart"], b["recordStart"] + b["recordCount"] - 1, b["bd"]))
        lines.append("                %s" % b["note"])
open(os.path.join(OUTDIR, "_MANIFEST_JAVA_RECOVERED.txt"), "w", encoding="utf-8").write("\n".join(lines) + "\n")

print("files written :", len(MAN))
for m in MAN:
    print("   %-52s %3d records  %s" % (m["file"], m["records"], ", ".join(m["rules"])))
print("\nwrote feed_index_t1.json and _MANIFEST_JAVA_RECOVERED.txt")
