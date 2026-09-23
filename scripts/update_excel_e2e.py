# -*- coding: utf-8 -*-
"""Write the executed verdicts back into the E2E workbook.

Reads automation/artifacts/e2e/verdicts/*.json and fills, per test case:
    col 25  Actual Code
    col 26  Actual Description
    col 27  Verdict
    col 28  Notes            (the existing data caveat is preserved)

Then rewrites a single EXECUTION RECORD block on the Overview sheet.

Idempotent: running it twice produces the same workbook. It never invents a
verdict, and it never promotes a FAIL. Cases with no verdict file are left
untouched rather than being marked anything.
"""
import glob
import json
import os
import collections
from datetime import datetime

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill

ROOT = r"C:\Users\RSERRANO\PRU ADB"
WORKBOOK = os.path.join(ROOT, "Test Data Scenarios for Demo", "PRU_ADB_E2E_Test_Scenarios_v4.xlsx")
VERDICTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "artifacts", "e2e", "verdicts")

FILL = {"PASS": PatternFill("solid", fgColor="E1F0E7"),
        "FAIL": PatternFill("solid", fgColor="FBE9E7"),
        "BLOCKED": PatternFill("solid", fgColor="FFF4E5"),
        "OBSERVED": PatternFill("solid", fgColor="EAF0F6")}
SMALL = Font(size=9)
WRAP = Alignment(wrap_text=True, vertical="top")
BLOCK_MARK = "EXECUTION RECORD"


def main():
    files = sorted(glob.glob(os.path.join(VERDICTS, "*.json")))
    if not files:
        raise SystemExit("No verdicts in %s.\nRun the e2e-execute then e2e-validate projects first."
                         % os.path.normpath(VERDICTS))
    V = {}
    for f in files:
        v = json.load(open(f, encoding="utf-8"))
        V[v["testCaseId"]] = v

    wb = openpyxl.load_workbook(WORKBOOK)
    ws = wb["E2E Test Cases"]

    written, unmatched = 0, []
    for r in range(4, ws.max_row + 1):
        tcid = ws.cell(r, 1).value
        if not tcid:
            continue
        v = V.pop(str(tcid).strip(), None)
        if not v:
            continue
        ws.cell(r, 25).value = v["actualCode"]
        ws.cell(r, 26).value = v["actualDescription"]
        ws.cell(r, 27).value = v["verdict"]

        prior = str(ws.cell(r, 28).value or "")
        # keep the data caveat, replace any previous execution note
        keep = prior.split("  Execution:")[0].strip()
        ws.cell(r, 28).value = (keep + "  Execution: " + v["notes"]).strip()

        for c in (25, 26, 27, 28):
            ws.cell(r, c).font = SMALL
            ws.cell(r, c).alignment = WRAP
        ws.cell(r, 27).fill = FILL.get(v["verdict"], PatternFill())
        written += 1
    unmatched = sorted(V)

    # ---------------------------------------------------- Overview block
    ov = wb["Overview"]
    start = None
    for r in range(1, ov.max_row + 1):
        if str(ov.cell(r, 1).value or "").strip() == BLOCK_MARK:
            start = r
            break
    if start:
        ov.delete_rows(start, ov.max_row - start + 2)
    else:
        start = ov.max_row + 2

    counts = collections.Counter(x["verdict"] for x in
                                 [json.load(open(f, encoding="utf-8")) for f in files])
    runs = {x for x in (json.load(open(f, encoding="utf-8")).get("runId") for f in files) if x}
    gens = {x for x in (json.load(open(f, encoding="utf-8")).get("generation") for f in files)
            if x is not None}

    rows = [
        (BLOCK_MARK, ""),
        ("Recorded", datetime.now().strftime("%d %B %Y, %H:%M")),
        ("Generation", ", ".join(str(g) for g in sorted(gens)) or "(not stamped)"),
        ("Runs executed", str(len(runs))),
        ("Test cases with a verdict", str(written)),
        ("PASS", str(counts.get("PASS", 0))),
        ("FAIL", str(counts.get("FAIL", 0))),
        ("BLOCKED", "%d - condition not forced by the feed, or the feed did not run. "
                    "Never a failure of the application." % counts.get("BLOCKED", 0)),
        ("OBSERVED", "%d - Confidence C. Behaviour recorded, not judged (Test Plan v1.00 section 6.3)."
                     % counts.get("OBSERVED", 0)),
    ]
    for i, (k, v) in enumerate(rows):
        a, b = ov.cell(start + i, 1, k), ov.cell(start + i, 2, v)
        a.font = Font(size=11, bold=True, color="0F4C5C") if i == 0 else Font(size=10, bold=True)
        b.font = Font(size=10)
        b.alignment = WRAP

    wb.save(WORKBOOK)
    print("verdicts written : %d" % written)
    for k in ("PASS", "FAIL", "BLOCKED", "OBSERVED"):
        print("   %-9s %d" % (k, counts.get(k, 0)))
    if unmatched:
        print("verdict files with no matching test case row: %s" % ", ".join(unmatched))


if __name__ == "__main__":
    main()
