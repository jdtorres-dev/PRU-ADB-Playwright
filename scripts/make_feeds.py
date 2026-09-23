# -*- coding: utf-8 -*-
"""Generate real LNA feed files (.txt) for the BRD v4 E2E suite.

Mirrors C:\\...\\006_Merged File\\ALLSTATE.LNA.DEMO-MERGED-BR031-035.D20260908.txt:
  600-byte fixed-width records, CRLF terminated, one submitting header (A),
  then bundles of B, C, D01, D02, Z.

One file per error code. Inside it, one bundle per business rule listed in
'Raised by rules', each carrying that rule's fault and nothing else.
"""
import os, re, json, collections
import openpyxl

ROOT = r"C:\Users\RSERRANO\PRU ADB"
SAMPLE = os.path.join(ROOT, "Test Data Scenarios for Demo", "006_Merged File",
                      "ALLSTATE.LNA.DEMO-MERGED-BR031-035.D20260908.txt")
OUTDIR = os.path.join(ROOT, "E2E Test Data")
os.makedirs(OUTDIR, exist_ok=True)
CRLF, RECLEN, FEED_DATE = b"\r\n", 600, "20260908"

# ---------------------------------------------------------------- references
raw = open(os.path.join(ROOT, "error_code_202609110900.txt"), encoding="utf-8-sig", errors="replace").read()
REF = {}
for line in [x.rstrip() for x in raw.replace("\r", "").split("\n") if x.strip()][1:]:
    m = re.match(r"^(\S+)\s{2,}(.*)$", line)
    if m:
        REF[m.group(1)] = m.group(2).strip()

wbb = openpyxl.load_workbook(os.path.join(ROOT, "ADB BRD v4 [for QA] (1).xlsx"), data_only=True)
wse, wsb = wbb["Error Codes"], wbb["Business Rules"]
GRP = {}
for r in range(2, 79):
    c = wse.cell(r, 1).value
    if not c:
        continue
    c = str(c).strip()
    if c in REF:
        GRP[c] = re.findall(r"BR-\d+", str(wse.cell(r, 5).value or ""))
RULES = {}
for r in range(2, 491):
    rid = wsb.cell(r, 2).value
    if rid:
        RULES[str(rid).strip()] = str(wsb.cell(r, 7).value or "")

LAYOUT = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "layout.json")))

# ---------------------------------------------------------------- baseline
src = [x for x in open(SAMPLE, "rb").read().split(CRLF) if x]
assert len(src) == 26 and all(len(x) == RECLEN for x in src)
A0, B0, C0, D010, D020, Z0 = src[0], src[1], src[2], src[3], src[4], src[5]

SPAN = {}          # (kind, field) -> (start, end)
for fld, places in LAYOUT.items():
    for kind, s, e in places:
        SPAN[(kind, fld)] = (s, e)


def put(rec, span, val):
    s, e = span
    n = e - s + 1
    v = str(val).encode("latin-1")
    assert len(v) <= n, (val, n)
    out = bytearray(rec)
    out[s - 1:e] = v.ljust(n)
    assert len(out) == RECLEN
    return bytes(out)


def setf(rec, kind, field, val):
    sp = SPAN.get((kind, field))
    if not sp:
        return rec, False
    return put(rec, sp, val), True


# ------------------------------------------------- fault map, per error code
# (record kind, field, invalid value, short note). Values follow the code's own
# description and the rule's stated thresholds.
SP9 = " " * 9
FAULT = {
    "B0100": ("B", "WS-ALLST-FIRM-NAME", "", "firm name not valued"),
    "B0200": ("B", "WS-ALLST-DIST-CHANNEL", "ZZ", "distribution channel outside the permitted set"),
    "B0300": ("B", "WS-BD-ALLSTATE-ID", "", "BD identifier not valued"),
    "B0500": ("C", "WS-ENTITY-TYPE", "LLE", "first firm entity is not a BD"),
    "B0601": ("C", "WS-TAX-ID-NUM", "111111111", "reserved tax identifier"),
    "B0602": ("C", "WS-FIRM-NAME", "", "firm name blank"),
    "B0604": ("C", "WS-ALLSTATE-ID", "", "Allstate identifier not valued"),
    "B0605": ("C", "WS-FIRM-TYPE", "ZZ", "firm type absent from the reference table"),
    "B0606": ("C", "WS-RES-STATE", "ZZ", "resident state absent from the state table"),
    "B0607": ("C", "WS-BUS-COMM-ADD-L1", "", "business address line 1 blank while city/state/ZIP present"),
    "B0608": ("C", "WS-CORRES-ADD-L1", "", "correspondence address line 1 blank"),
    "B0609": ("C", "WS-PROFILE-STATUS", "X", "profile status outside A / I / T"),
    "B0610": ("C", "WS-PROF-START-DT", "00000000", "profile start date not a real date"),
    "B0611": ("C", "WS-PROF-TERM-DT", "00000000", "profile termination date not a real date"),
    "B0612": ("C", "WS-FIRM-ALLSTATE-ID", "", "firm Allstate identifier not valued"),
    "B0613": ("C", "WS-BD-ALLSTATE-ID", "", "BD Allstate identifier not valued"),
    "C0701": ("C", "WS-TAX-ID-NUM", "111111111", "reserved tax identifier"),
    "C0702": ("C", "WS-FIRM-NAME", "", "firm name blank"),
    "C0703": ("C", "WS-ABBR-FIRM-NAME", "", "abbreviated firm name invalid"),
    "C0704": ("C", "WS-ALLSTATE-ID", "", "Allstate identifier not valued"),
    "C0705": ("C", "WS-FIRM-TYPE", "ZZ", "firm type absent from the reference table"),
    "C0706": ("C", "WS-RES-STATE", "ZZ", "resident state absent from the state table"),
    "C0707": ("C", "WS-BUS-COMM-ADD-L1", "", "business address line 1 blank while city/state/ZIP present"),
    "C0708": ("C", "WS-CORRES-ADD-L1", "", "correspondence address line 1 blank"),
    "C0709": ("C", "WS-PROFILE-STATUS", "X", "profile status outside A / T / I"),
    "C0710": ("C", "WS-PROF-START-DT", "00000000", "profile start date not a real date"),
    "C0711": ("C", "WS-PROF-TERM-DT", "00000000", "profile termination date not a real date"),
    "C0712": ("C", "WS-FIRM-ALLSTATE-ID", "", "firm Allstate identifier not valued"),
    "C0713": ("C", "WS-BD-ALLSTATE-ID", "", "BD Allstate identifier not valued"),
    "C0716": ("C", "WS-ENTITY-TYPE", "ZZZ", "entity type outside BD / LLE / HA"),
    "D0101": ("D01", "WS-SOC-SEC-NUM", "12345ABCD", "identifier not nine numeric positions"),
    "D0102": ("D01", "WS-FIRST-NAME", "", "first name blank"),
    "D0103": ("D01", "WS-LAST-NAME", "", "last name blank"),
    "D0104": ("D01", "WS-DOB", "20110909", "date of birth under the 5,844-day minimum"),
    "D0105": ("D01", "WS-SEX-CD", "X", "sex code outside M / F / U / blank"),
    "D0106": ("D01", "WS-HOME-ADD-L1", "", "home address line 1 blank while city/state/ZIP present"),
    "D0107": ("D01", "WS-DESIGNATION1-7", "ZZZZZ", "designation absent from the reference table"),
    "F0101": ("D02", "WS-SOC-SEC-NUM", "987654321", "identifier does not match the producer entity record"),
    "F0102": ("D02", "WS-PROF-TYPE", "X", "profile type is neither C nor H"),
    "F0103": ("D02", "WS-ALLSTATE-ID", "", "Allstate identifier blank"),
    "F0104": ("D02", "WS-BUS-ADD-L1", "", "business address line 1 blank"),
    "F0105": ("D02", "WS-RES-STATE", "ZZ", "resident state absent from the state table"),
    "F0106": ("D02", "WS-PROD-ROLE", "ABC", "producer role must be spaces"),
    "F0107": ("D02", "WS-FIRM-ALLSTATE-ID", "", "firm Allstate identifier blank"),
    "F0108": ("D02", "WS-BD-ALLSTATE-ID", "", "BD Allstate identifier blank"),
    "F0110": ("D02", "WS-RELN-STATUS", "X", "relationship status outside A / T / I"),
    "F0111": ("D02", "WS-RELN-START-DT", "00000000", "relationship start date not a real date"),
    "F0112": ("D02", "WS-RELN-END-DT", "00000000", "relationship end date not a real date"),
}
# codes whose condition is structural or depends on system state
STRUCTURAL = {
    "B0400": "bundle omits its firm entity record; the next contra header arrives first",
    "E0100": "a second producer entity record arrives in place of the producer profile",
}
STATEFUL = {
    "B0700": "the broker dealer named on the contra header must ALREADY exist in ADB",
    "C0714": "a second BD entity with profile status A inside the same bundle",
    "C0715": "an active LLE or HA inside a bundle whose broker dealer is terminated",
    "C0717": "a house account whose functional manager record is not present",
    "D2731": "relationship status A where the parent broker dealer relationship is absent",
    "F0109": "relationship status A inside a bundle whose broker dealer is terminated",
    "F0113": "an investment professional whose functional manager record is not present",
    "O2711": "the organisation service must return an unsuccessful outcome - not forceable from file content",
    "P2721": "the appointment service must return an unsuccessful outcome - not forceable from file content",
}
STANDALONE = {"BR-209": "C", "BR-221": "D01", "BR-233": "D02"}

BD_POS = [("B", 54, 63), ("C", 88, 97), ("C", 516, 525), ("C", 526, 535), ("D02", 241, 250), ("D02", 251, 260)]


GEN = int(os.environ.get("E2E_GENERATION", "0"))
GSEQ = [0]
LAST_BD = [""]          # runs across every file, not just within one


def identity(recs, seq):
    """Give one bundle its own firm, broker dealer and producer.

    The counter runs across the whole set, so no two bundles in any of the 68
    feed files share an identifier. E2E_GENERATION stamps the run: the
    environment has no data reset, so a committed organisation cannot be
    presented again and every re-run needs a fresh generation.
    """
    GSEQ[0] += 1
    n = GSEQ[0]
    bd = "A%02d%05d00" % (GEN, n)
    LAST_BD[0] = bd
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
    return [B, C, D1, D2, Z]



# The two firm-entity code families name different positions in the bundle, not
# different faults. B06xx is raised against the FIRST firm entity, which is the
# broker dealer; C07xx against a firm entity that follows it. A bundle carrying a
# single firm therefore always raises the B06xx code, and the C07xx rule is never
# reached. These codes need a valid broker dealer first, then a second firm
# entity carrying the fault.
SUBSEQUENT_FIRM = {"C0701", "C0702", "C0703", "C0704", "C0705", "C0706", "C0707", "C0708",
                   "C0709", "C0710", "C0711", "C0712", "C0713", "C0716"}


def as_subsequent_firm(C, seq):
    """Turn the faulted firm entity into a legal entity under the broker dealer.

    Applied BEFORE the fault is injected, so a fault that targets one of these
    same fields still wins.
    """
    lle = "L%02d%04d000" % (GEN, seq)
    C = put(C, (2, 10), "%02d%07d" % (GEN, 2000000 + seq))      # its own tax id
    C = put(C, (11, 60), "E2E G%02d LLE %04d LLC" % (GEN, seq))  # its own name
    C = put(C, (88, 97), lle)                                    # its own partner id
    C = put(C, (98, 100), "LLE")                                 # a legal entity, not the BD
    C = put(C, (526, 535), lle)                                  # firm id is its own
    return C                                                      # 516-525 keeps the parent BD


MANIFEST = []
skipped = []

for code in sorted(GRP):
    brs = GRP[code]
    if not brs:
        continue
    body, notes = [], []
    seq = 0
    for i, br in enumerate(brs, 1):
        seq += 1
        bundle = identity([B0, C0, D010, D020, Z0], seq)
        bundle_bd = LAST_BD[0]
        B, C, D1, D2, Z = bundle
        C_bd = None
        if code in SUBSEQUENT_FIRM:
            C_bd = C                      # the valid broker dealer, kept as identity built it
            C = as_subsequent_firm(C, GSEQ[0])
        applied = ""
        if code in FAULT:
            kind, field, val, note = FAULT[code]
            tgt = {"B": B, "C": C, "D01": D1, "D02": D2}[kind]
            newrec, ok = setf(tgt, kind, field, val)
            if ok:
                if kind == "B": B = newrec
                elif kind == "C": C = newrec
                elif kind == "D01": D1 = newrec
                else: D2 = newrec
                applied = "%s.%s = %s (%s)" % (kind, field, repr(val), note)
            else:
                applied = "FIELD %s NOT IN LAYOUT - fault not injected" % field
        elif code in STRUCTURAL:
            applied = "structural: " + STRUCTURAL[code]
        elif code in STATEFUL:
            applied = "precondition: " + STATEFUL[code]
        else:
            applied = "no fault mapping for this code"

        if br in STANDALONE:
            keep = STANDALONE[br]
            rec = {"C": C, "D01": D1, "D02": D2}[keep]
            body.append(rec)
            notes.append((i, br, 1, "standalone %s record outside any bundle | %s" % (keep, applied), bundle_bd))
        elif code == "B0400":
            body += [B, D1, D2, Z]          # firm entity record deliberately omitted
            notes.append((i, br, 4, applied, bundle_bd))
        elif code == "E0100":
            body += [B, C, D1, D1, Z]       # a second D01 in place of the D02
            notes.append((i, br, 5, applied, bundle_bd))
        elif C_bd is not None:
            # valid BD firm first, then the faulted firm entity beneath it
            body += [B, C_bd, C, D1, D2, Z]
            notes.append((i, br, 6, applied +
                          " | presented as a legal entity beneath a valid broker dealer, so the "
                          "code names a subsequent firm entity rather than the first", bundle_bd))
        else:
            body += [B, C, D1, D2, Z]
            notes.append((i, br, 5, applied, bundle_bd))

    total = 1 + len(body)
    A = put(A0, (102, 109), FEED_DATE)
    A = put(A, (110, 121), str(total).rjust(12, "0"))
    recs = [A] + body
    for x in recs:
        assert len(x) == RECLEN

    fn = "ALLSTATE.LNA.%s.D%s.txt" % (code, FEED_DATE)
    open(os.path.join(OUTDIR, fn), "wb").write(CRLF.join(recs) + CRLF)
    MANIFEST.append(dict(file=fn, code=code, desc=REF[code], brs=brs, records=total,
                         bundles=len(brs), notes=notes,
                         kind="fault injected" if code in FAULT else
                              ("structural" if code in STRUCTURAL else
                               ("precondition required" if code in STATEFUL else "unmapped"))))
    if code in STATEFUL:
        skipped.append((code, STATEFUL[code]))

# ------------------------------------------------------------------ manifest
lines = []
lines.append("PRU ADB - E2E TEST DATA (BRD v4)")
lines.append("=" * 100)
lines.append("")
lines.append("Format mirrors ALLSTATE.LNA.DEMO-MERGED-BR031-035.D20260908.txt:")
lines.append("  600-byte fixed-width records, CRLF terminated, one submitting header (A),")
lines.append("  then one bundle (B, C, D01, D02, Z) per business rule.")
lines.append("")
lines.append("One file per error code. The number of bundles equals the number of business rules")
lines.append("listed in 'Raised by rules' for that code. Each bundle carries ONE rule's fault and")
lines.append("its own firm, broker dealer and producer identity so the rules cannot interfere.")
lines.append("")
lines.append("Feed Date for every file: %s (carried on the submitting header)." % FEED_DATE)
lines.append("")
lines.append("=" * 100)
for m in MANIFEST:
    lines.append("")
    lines.append("%s" % m["file"])
    lines.append("  code        : %s" % m["code"])
    lines.append("  description : %s" % m["desc"])
    lines.append("  records     : %d  (1 header + %d bundle record(s))" % (m["records"], m["records"] - 1))
    lines.append("  rules       : %s" % ", ".join(m["brs"]))
    lines.append("  data type   : %s" % m["kind"])
    for i, br, n, applied, bd in m["notes"]:
        lines.append("     bundle %d  %-8s %d record(s)  bd=%s  %s" % (i, br, n, bd, applied))
open(os.path.join(OUTDIR, "_MANIFEST.txt"), "w", encoding="utf-8").write("\n".join(lines) + "\n")

print("output folder:", OUTDIR)
print("feed files   :", len(MANIFEST))
print("total records:", sum(m["records"] for m in MANIFEST))
print()
print("by data type:")
for k, v in collections.Counter(m["kind"] for m in MANIFEST).most_common():
    print("   %-24s %d" % (k, v))
print()
print("codes needing a system-state precondition (file generated, note in manifest):")
for c, n in skipped:
    print("   %-7s %s" % (c, n))

# ------------------------------------------------------------------ index for the automation
IDX = {}
for m in MANIFEST:
    pos, bundles = 2, []          # record 1 is the submitting header
    for i, br, n, applied, bd in m["notes"]:
        bundles.append(dict(index=i, br=br, recordStart=pos, recordCount=n, note=applied, bd=bd,
                            cls=("precondition" if m["kind"] == "precondition required"
                                 else ("structural" if m["kind"] == "structural"
                                       else ("fault injected" if m["kind"] == "fault injected"
                                             else "unmapped")))))
        pos += n
    IDX[m["file"]] = dict(code=m["code"], description=m["desc"], records=m["records"],
                          family="error-code", bundles=bundles)
json.dump(IDX, open("feed_index_err.json", "w"), indent=1)
print("\nwrote feed_index_err.json")
