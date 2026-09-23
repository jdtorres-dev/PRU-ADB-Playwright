# -*- coding: utf-8 -*-
"""Build the automation's test-case registry from the E2E workbook.

The workbook is the definition of record; the automation must never carry its
own copy of an expected error code. This reads PRU_ADB_E2E_Test_Scenarios_v4.xlsx
plus the two feed indexes written by the feed builders, and emits:

    data/test-cases.json   one entry per test case, with its feed file, the
                           record positions it occupies, and what to expect
    data/feeds.json        one entry per feed file, in upload order

Run this whenever the workbook or the feed files change.
"""
import json
import os
import re
import sys

import openpyxl

from _paths import WORKBOOK

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
INDEX_SRC = [os.path.join(HERE, "feed_index_err.json"), os.path.join(HERE, "feed_index_dest.json"),
             os.path.join(HERE, "feed_index_t1.json"),
             os.path.join(HERE, "feed_index_state.json")]

COL = dict(id=1, rule=2, desc=3, topic=4, type=5, priority=6, route=7, automation=8, bcr=9,
           fields=10, trigger=11, isolation=12, code=13, errdesc=14, raised=15, files=16,
           records=17, valsrc=18, dest=19, outcome=20, disposition=21, expcode=22, effect=23,
           program=24, actualcode=25, actualdesc=26, verdict=27, notes=28)

# A case can only return a verdict if its condition is actually forced by the file.
DRIVEN = {"fault injected", "structural", "positive", "header fault injected"}

# The test is not "did the expected error code fire" - it is "did the output land at
# the destination the BRD assigns". So a case is executable whenever that destination
# is an artifact we actually download. Whether the record reaches it is the verdict,
# not a precondition for having one.
def destination_artifact(dest):
    d = dest or ""
    if "ERRFILE" in d:
        return "ERRFILE"          # named, but never present in the download
    if "ADBSKIP" in d:
        return "ADBSKIP"
    if "LNAERROR" in d:
        return "LNAERROR"
    if "CNTLRPT" in d:
        return "CNTLRPT"
    if d.startswith("Report output"):
        return "LOADFILE"
    return ""                      # Java exception, Log only, None - nothing to read


OBSERVABLE = {"LNAERROR", "ADBSKIP", "CNTLRPT", "LOADFILE"}
UNOBSERVABLE_REASON = {
    "ERRFILE": "Output is assigned to errfile-<CCYYMMDD>.csv. Across every executed run the "
               "General Artifacts download has never contained one, so there is no folder to "
               "check. Blocked on access, not on test data.",
    "": "The destination is a Java exception, the application log, or none at all. Nothing is "
        "written to a file we can read, so there is no destination to check.",
}


def main():
    idx = {}
    for p in INDEX_SRC:
        if not os.path.exists(p):
            sys.exit("missing feed index: %s\nRun the feed builders first." % p)
        idx.update(json.load(open(p)))

    ws = openpyxl.load_workbook(WORKBOOK, data_only=True)["E2E Test Cases"]
    cases, seen_feeds = [], []

    for r in range(4, ws.max_row + 1):
        if not ws.cell(r, COL["id"]).value:
            continue
        g = lambda k: (str(ws.cell(r, COL[k]).value).strip()
                       if ws.cell(r, COL[k]).value not in (None, "") else "")

        files = [x.strip() for x in g("files").split(",") if x.strip()]
        rule = g("rule")

        if not files or files[0].startswith("(none"):
            cases.append(dict(
                id=g("id"), rule=rule, topic=g("topic"), type=g("type"), priority=g("priority"),
                route=g("route"), bcr=bool(g("bcr")), expectedCode=g("code"),
                expectedDescription=g("errdesc"), expectedDestination=g("dest"),
                validationSource=g("valsrc"), program=g("program"), feeds=[],
                destinationArtifact=destination_artifact(g("dest")), conditionForced=False,
                executable=False,
                blockedReason="No feed file exists for this case. %s" % g("notes"),
            ))
            continue

        targets, drivable, notes = [], False, []
        for f in files:
            entry = idx.get(f)
            if not entry:
                notes.append("feed file %s is not in the index" % f)
                continue
            seen_feeds.append(f)
            for b in entry["bundles"]:
                if b["br"] != rule:
                    continue
                targets.append(dict(feed=f, bundleIndex=b["index"],
                                    recordStart=b["recordStart"], recordCount=b["recordCount"],
                                    recordEnd=b["recordStart"] + b["recordCount"] - 1,
                                    cls=b["cls"], note=b["note"], bd=b.get("bd", "")))
                if b["cls"] in DRIVEN:
                    drivable = True

        if not targets:
            notes.append("no bundle for %s was found in %s" % (rule, ", ".join(files)))

        classes = sorted({t["cls"] for t in targets})
        art = destination_artifact(g("dest"))
        blocked = ""
        if not targets:
            blocked = "; ".join(notes)
        elif art not in OBSERVABLE:
            blocked = UNOBSERVABLE_REASON[art if art in UNOBSERVABLE_REASON else ""]

        cases.append(dict(
            id=g("id"), rule=rule, topic=g("topic"), type=g("type"), priority=g("priority"),
            route=g("route"), bcr=bool(g("bcr")), expectedCode=g("code"),
            expectedDescription=g("errdesc"), expectedDestination=g("dest"),
            validationSource=g("valsrc"), program=g("program"),
            feeds=targets, classes=classes,
            destinationArtifact=art,
            # True when the condition is forced by the file. Recorded so a verdict can
            # say whether reaching the destination was expected or incidental.
            conditionForced=drivable,
            executable=not blocked,
            blockedReason=blocked,
        ))

    # A setup file exists only to commit state for a later file, so no test case
    # names it. It still has to be uploaded, and before the file that depends on it.
    setup = [f for f, e in idx.items() if e.get("phase", 1) == 0]
    order = []
    for f in sorted(set(seen_feeds) | set(setup)):
        e = idx[f]
        # Recorded as a relative, portable path - registry.ts resolves the
        # working file by name under data/feeds/ regardless of this value;
        # it is kept for provenance/history, not as a live lookup path.
        order.append(dict(file=f, path="data/feeds/" + f, family=e["family"],
                          code=e.get("code", ""), destination=e.get("destination", ""),
                          phase=e.get("phase", 1),
                          records=e["records"], bundles=len(e["bundles"]),
                          cases=[c["id"] for c in cases if any(t["feed"] == f for t in c["feeds"])]))
    order.sort(key=lambda f: (f["phase"], f["file"]))

    os.makedirs(DATA, exist_ok=True)
    json.dump(cases, open(os.path.join(DATA, "test-cases.json"), "w"), indent=1)
    json.dump(order, open(os.path.join(DATA, "feeds.json"), "w"), indent=1)

    ex = sum(1 for c in cases if c["executable"])
    print("test cases      : %d" % len(cases))
    print("  executable    : %d" % ex)
    print("  blocked       : %d" % (len(cases) - ex))
    print("  of which BCR  : %d (observe and record, never pass/fail)"
          % sum(1 for c in cases if c["bcr"]))
    print("feed files      : %d" % len(order))
    missing = [f["file"] for f in order if not os.path.exists(os.path.join(HERE, "..", f["path"]))]
    print("missing on disk : %d %s" % (len(missing), missing[:3]))


if __name__ == "__main__":
    main()
