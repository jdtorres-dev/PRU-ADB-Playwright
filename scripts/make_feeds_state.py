# -*- coding: utf-8 -*-
"""Feed files for the conditions that depend on state.

Twelve cases were classed 'needs state already committed in ADB'. Reading each
one's condition against its error-code description, that was too broad:

  8   are conditions WITHIN a bundle - a second active broker dealer, an active
      legal entity under a terminated one, a house account whose functional
      manager is absent. One file each, no prior run needed.
  1   is genuinely two-phase - B0700 refuses a broker dealer that already exists,
      so one run must commit it before another presents it again.
  3   need a downstream service to fail (O2711 / P2721). No file can cause that;
      they belong with the cases parked on database access.
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

SEQ = [90000]           # clear of every other band


def put(rec, s, e, val):
    n = e - s + 1
    v = str(val).encode("latin-1")
    assert len(v) <= n, (val, n)
    out = bytearray(rec)
    out[s - 1:e] = v.ljust(n)
    return bytes(out)


def ids(n):
    return dict(bd="A%02d%05d00" % (GEN, n), tax="%02d%07d" % (GEN, 1000000 + n),
                ssn="%02d%07d" % (GEN, 5000000 + n), pid="P%02d%05d00" % (GEN, n),
                firm="E2E G%02d B%05d LLC" % (GEN, n))


def bundle(bd=None):
    """A valid bundle. Pass bd to reuse a broker dealer identifier from an earlier run."""
    SEQ[0] += 1
    i = ids(SEQ[0])
    if bd:
        i["bd"] = bd
    B = put(put(B0, 2, 51, i["firm"]), 54, 63, i["bd"])
    C = put(put(C0, 2, 10, i["tax"]), 11, 60, i["firm"])
    for s, e in ((88, 97), (516, 525), (526, 535)):
        C = put(C, s, e, i["bd"])
    C = put(C, 98, 100, "BD")
    C = put(C, 499, 499, "A")
    D1 = put(D010, 4, 12, i["ssn"])
    D2 = put(put(D020, 4, 12, i["ssn"]), 14, 23, i["pid"])
    for s, e in ((241, 250), (251, 260)):
        D2 = put(D2, s, e, i["bd"])
    return B, C, D1, D2, Z0, i


def firm(base_C, *, entity, status, own_id, parent_bd, seq):
    """A further firm entity in the same bundle, with its own identity."""
    C = put(base_C, 2, 10, "%02d%07d" % (GEN, 3000000 + seq))
    C = put(C, 11, 60, "E2E G%02d %s %04d LLC" % (GEN, entity, seq))
    C = put(C, 88, 97, own_id)
    C = put(C, 98, 100, entity)
    C = put(C, 499, 499, status)
    C = put(C, 516, 525, parent_bd)
    C = put(C, 526, 535, own_id)
    return C


def header(total):
    return put(put(A0, 102, 109, FEED_DATE), 110, 121, str(total).rjust(12, "0"))


MAN = []


def write(tag, recs, rules, bundles, summary, family="state"):
    for r in recs:
        assert len(r) == RECLEN, len(r)
    fn = "ALLSTATE.LNA.%s.D%s.txt" % (tag, FEED_DATE)
    open(os.path.join(OUTDIR, fn), "wb").write(CRLF.join(recs) + CRLF)
    MAN.append(dict(file=fn, records=len(recs), rules=rules, bundles=bundles,
                    summary=summary, family=family))


def one(tag, rule, recs, note, bd, summary):
    write(tag, [header(1 + len(recs))] + recs, [rule],
          [dict(br=rule, recordStart=2, recordCount=len(recs), note=note, bd=bd,
                cls="fault injected")], summary)


# ---------------------------------------------------------------- C0714
# "MORE THAN ONE ACTIVE BD ENTITY TYPE NOT ALLOWED WITHIN A BD FIRM BUNDLE"
B, C, D1, D2, Z, i = bundle()
second_bd = firm(C0, entity="BD", status="A", own_id="A%02d%05d01" % (GEN, SEQ[0]),
                 parent_bd=i["bd"], seq=SEQ[0])
one("STATE-C0714-SECOND-ACTIVE-BD", "BR-199", [B, C, second_bd, D1, D2, Z],
    "a second firm entity of type BD carrying profile status A in the same bundle",
    i["bd"], "A non-first BD record may never carry status Active.")

# ---------------------------------------------------------------- C0715 x3
# "ACTIVE LLE'S / HA'S PRESENT WITHIN A TERMINATED BD FIRM BUNDLE"
for rule, ent in (("BR-063", "LLE"), ("BR-200", "HA"), ("BR-212", "LLE")):
    B, C, D1, D2, Z, i = bundle()
    C_term = put(C, 499, 499, "T")                      # the broker dealer is terminated
    child = firm(C0, entity=ent, status="A", own_id="%s%02d%04d0" % (ent[0], GEN, SEQ[0]),
                 parent_bd=i["bd"], seq=SEQ[0])
    one("STATE-C0715-%s-ACTIVE-UNDER-TERMINATED-BD-%s" % (ent, rule[-3:]), rule,
        [B, C_term, child, D1, D2, Z],
        "broker dealer profile status T (terminated) with an active %s beneath it" % ent,
        i["bd"], "An active legal entity or house account inside a terminated BD bundle.")

# ---------------------------------------------------------------- C0717 x2
# "HA RECORD REJECTED BECAUSE THE FUNCTIONAL MANAGER (BD OR LLE) RECORD WAS NOT FOUND"
for rule in ("BR-206", "BR-213"):
    B, C, D1, D2, Z, i = bundle()
    absent = "A%02d%05d99" % (GEN, SEQ[0])              # a manager that is nowhere
    ha = firm(C0, entity="HA", status="A", own_id="H%02d%04d0" % (GEN, SEQ[0]),
              parent_bd=absent, seq=SEQ[0])
    one("STATE-C0717-HA-NO-MANAGER-%s" % rule[-3:], rule, [B, C, ha, D1, D2, Z],
        "house account whose functional manager identifier %s is present in no bundle and "
        "exists nowhere in ADB" % absent,
        i["bd"], "A house account whose functional manager record cannot be found.")

# ---------------------------------------------------------------- F0113
# "IP RECORD REJECTED BECAUSE THE FUNCTIONAL MANAGER (BD OR LLE) RECORD WAS NOT FOUND"
B, C, D1, D2, Z, i = bundle()
absent = "A%02d%05d98" % (GEN, SEQ[0])
D2_orphan = put(put(D2, 241, 250, absent), 251, 260, absent)
one("STATE-F0113-IP-NO-MANAGER", "BR-235", [B, C, D1, D2_orphan, Z],
    "producer profile pointing at functional manager %s, which is in no bundle and exists "
    "nowhere in ADB" % absent,
    i["bd"], "An investment professional whose functional manager record cannot be found.")

# ---------------------------------------------------------------- D2731 / F0109
# "Parent BD must be active" - relationship status A beneath a terminated broker dealer
B, C, D1, D2, Z, i = bundle()
one("STATE-D2731-ACTIVE-UNDER-TERMINATED-BD", "BR-236",
    [B, put(C, 499, 499, "T"), D1, put(D2, 261, 261, "A"), Z],
    "broker dealer profile status T with a producer profile carrying relationship status A",
    i["bd"], "A relationship presented as active while its parent broker dealer is terminated.")

# ---------------------------------------------------------------- B0700, two-phase
# "ALLSTATE BD ID ALREADY PRESENT IN ADB AS BD. BD FIRM BUNDLE REJECTED"
# Phase one commits the broker dealer. Phase two presents the same identifier again.
B, C, D1, D2, Z, i = bundle()
write("SETUP-B0700-COMMIT-BD", [header(6), B, C, D1, D2, Z], [],
      [dict(br="(setup)", recordStart=2, recordCount=5,
            note="a wholly valid bundle whose only job is to commit broker dealer %s" % i["bd"],
            bd=i["bd"], cls="setup")],
      "Phase one of two. Commits the broker dealer that STATE-B0700-DUPLICATE-BD then re-presents.",
      family="setup")

B2, C2, D12, D22, Z2, i2 = bundle(bd=i["bd"])          # same broker dealer, fresh everything else
one("STATE-B0700-DUPLICATE-BD", "BR-177", [B2, C2, D12, D22, Z2],
    "broker dealer %s was committed by SETUP-B0700-COMMIT-BD in the same run; this bundle "
    "presents it a second time" % i["bd"],
    i["bd"], "Phase two of two. Must be uploaded after SETUP-B0700-COMMIT-BD.")

# ------------------------------------------------------------------ outputs
IDX = {}
for m in MAN:
    IDX[m["file"]] = dict(code="", description="", records=m["records"], family=m["family"],
                          destination="", phase=0 if m["family"] == "setup" else 1,
                          bundles=[dict(index=n + 1, **b) for n, b in enumerate(m["bundles"])])
json.dump(IDX, open(os.path.join(HERE, "feed_index_state.json"), "w"), indent=1)

L = ["PRU ADB - E2E TEST DATA FOR STATE-DEPENDENT CONDITIONS", "=" * 100, "",
     "Twelve cases were classed 'needs state already committed in ADB'. Eight turned out to be",
     "conditions within a bundle and need no prior run at all. One is genuinely two-phase. Three",
     "need a downstream service to fail and no file can cause that.", "",
     "Feed Date: %s. Generation: %02d." % (FEED_DATE, GEN), "", "=" * 100]
for m in MAN:
    L += ["", m["file"], "  records : %d" % m["records"],
          "  rules   : %s" % (", ".join(m["rules"]) or "(setup only - no test case)"),
          "  %s" % m["summary"]]
    for b in m["bundles"]:
        L.append("     %-9s records %d-%d  bd=%s"
                 % (b["br"], b["recordStart"], b["recordStart"] + b["recordCount"] - 1, b["bd"]))
        L.append("               %s" % b["note"])
L += ["", "=" * 100, "UPLOAD ORDER", "",
      "  SETUP-B0700-COMMIT-BD must be uploaded BEFORE STATE-B0700-DUPLICATE-BD.",
      "  The execution phase orders feeds by phase, so this happens on its own.", ""]
open(os.path.join(OUTDIR, "_MANIFEST_STATE.txt"), "w", encoding="utf-8").write("\n".join(L) + "\n")

print("files written:", len(MAN))
for m in MAN:
    print("   %-58s %2d records  %s" % (m["file"][13:], m["records"],
                                        ", ".join(m["rules"]) or "(setup)"))
print("\nnot buildable - a downstream service must fail: BR-048, BR-251, BR-253")
