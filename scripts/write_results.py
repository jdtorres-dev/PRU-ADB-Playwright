# -*- coding: utf-8 -*-
"""Write the full execution result into the E2E workbook.

update_excel_e2e.py fills the four result columns. This adds what the
destination-based run actually establishes, which those four cannot carry:

    col 30  Actual Destination      where the output landed
    col 31  Verification Basis      whether the rule's own condition was forced,
                                    or the record was valid and this confirms routing
    col 32  Live Console            the application's own account of the run

and rewrites the Overview execution block. Idempotent: run it as often as needed.
"""
import collections
import glob
import json
import os
from datetime import datetime

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

ROOT = r"C:\Users\RSERRANO\PRU ADB"
HERE = os.path.dirname(os.path.abspath(__file__))
WB = os.path.join(ROOT, "Test Data Scenarios for Demo", "PRU_ADB_E2E_Test_Scenarios_v4.xlsx")
VERDICTS = os.path.join(HERE, "..", "artifacts", "e2e", "verdicts")
RUNS = os.path.join(HERE, "..", "artifacts", "e2e", "runs")

FILL = {"PASS": "E1F0E7", "FAIL": "FBE9E7", "BLOCKED": "FFF4E5", "OBSERVED": "EAF0F6"}
SMALL = Font(size=9)
WRAP = Alignment(wrap_text=True, vertical="top")
THIN = Side(style="thin", color="D3DDE1")
BORD = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HDR = PatternFill("solid", fgColor="0F4C5C")
HDRF = Font(color="FFFFFF", bold=True, size=10)
BLOCK = "EXECUTION RECORD"

NEW = [(30, "Actual Destination", 26), (31, "Verification Basis", 46), (32, "Live Console", 52)]


def main():
    V = {}
    for f in glob.glob(os.path.join(VERDICTS, "*.json")):
        x = json.load(open(f, encoding="utf-8"))
        V[x["testCaseId"]] = x
    if not V:
        raise SystemExit("No verdicts found. Run the e2e-validate project first.")

    cases = {x["id"]: x for x in json.load(open(os.path.join(HERE, "..", "data", "test-cases.json")))}
    runs = {}
    for f in glob.glob(os.path.join(RUNS, "*.json")):
        r = json.load(open(f, encoding="utf-8"))
        runs[r["feedFile"]] = r

    wb = openpyxl.load_workbook(WB)
    ws = wb["E2E Test Cases"]

    for col, title, width in NEW:
        c = ws.cell(3, col, title)
        c.fill = HDR
        c.font = HDRF
        c.border = BORD
        c.alignment = Alignment(wrap_text=True, vertical="center")
        ws.column_dimensions[get_column_letter(col)].width = width

    written = 0
    for r in range(4, ws.max_row + 1):
        tc = ws.cell(r, 1).value
        if not tc:
            continue
        v = V.get(str(tc).strip())
        if not v:
            continue
        case = cases.get(str(tc).strip(), {})
        run = runs.get(v.get("feedFile", ""), {})
        o = run.get("outcome") or {}

        ws.cell(r, 25).value = v["actualCode"]
        ws.cell(r, 26).value = v["actualDescription"]
        ws.cell(r, 27).value = v["verdict"]
        ws.cell(r, 30).value = v["actualDestination"] or "(none)"

        if v["verdict"] == "BLOCKED":
            basis = "Not executed - " + (
                "the error file is not in the download" if case.get("destinationArtifact") == "ERRFILE"
                else "no destination that can be read")
        elif case.get("conditionForced"):
            basis = ("Rule condition forced by the feed file. The verdict is about the rule "
                     "itself: did its output reach the assigned destination?")
        else:
            basis = ("Record is valid - nothing in it violates a rule. The verdict is about "
                     "routing: was it applied to the successful output rather than an error report?")
        ws.cell(r, 31).value = basis

        ws.cell(r, 32).value = (
            "%d committed, %d rolled back, %d skipped%s"
            % (o.get("committed", 0), o.get("rolledBack", 0), o.get("skipped", 0),
               (" | " + "; ".join(w.split(" ", 2)[-1] for w in o.get("warnings", [])[:2]))
               if o.get("warnings") else "")
        ) if run else "(not executed)"

        prior = str(ws.cell(r, 28).value or "").split("  Execution:")[0].strip()
        ws.cell(r, 28).value = (prior + "  Execution: " + v["notes"]).strip()

        for col in (25, 26, 27, 28, 30, 31, 32):
            ws.cell(r, col).font = SMALL
            ws.cell(r, col).alignment = WRAP
        ws.cell(r, 27).fill = PatternFill("solid", fgColor=FILL.get(v["verdict"], "FFFFFF"))
        ws.cell(r, 30).fill = PatternFill("solid", fgColor=FILL.get(v["verdict"], "FFFFFF"))
        written += 1

    # ------------------------------------------------------------- Overview
    ov = wb["Overview"]
    start = None
    for r in range(1, ov.max_row + 1):
        if str(ov.cell(r, 1).value or "").strip() == BLOCK:
            start = r
            break
    if start:
        ov.delete_rows(start, ov.max_row - start + 2)
    else:
        start = ov.max_row + 2

    cnt = collections.Counter(x["verdict"] for x in V.values())
    forced = sum(1 for k, x in V.items()
                 if x["verdict"] == "PASS" and cases.get(k, {}).get("conditionForced"))
    routing = cnt["PASS"] - forced
    gens = {r.get("generation") for r in runs.values() if r.get("generation") is not None}
    sqlfail = sum(1 for r in runs.values()
                  if any("SQL dump failed" in w for w in (r.get("outcome") or {}).get("warnings", [])))

    rows = [
        (BLOCK, ""),
        ("Recorded", datetime.now().strftime("%d %B %Y, %H:%M")),
        ("Generation", ", ".join(str(g) for g in sorted(gens)) or "(not stamped)"),
        ("Feed files uploaded", str(len(runs))),
        ("Test cases with a verdict", str(written)),
        ("", ""),
        ("PASS", "%d  (%d where the rule's own condition was forced, %d confirming that a valid "
                 "record was applied)" % (cnt["PASS"], forced, routing)),
        ("FAIL", "%d  - output reached a destination other than the one the BRD assigns"
                 % cnt["FAIL"]),
        ("BLOCKED", "%d  - no destination that can be read. 24 are assigned to the error file, "
                    "which has never appeared in the download; the rest write only to a Java "
                    "exception or the application log." % cnt["BLOCKED"]),
        ("OBSERVED", "%d  - Confidence C. Behaviour recorded, not judged (Test Plan v1.00 §6.3)."
                     % cnt["OBSERVED"]),
        ("", ""),
        ("How a verdict was decided",
         "Where the feed file forces the rule's condition, the output must reach the destination "
         "the BRD assigns to that rule. Where the record is valid, the right destination is the "
         "successful output - a valid record cannot appear on an error report. The expected error "
         "code is evidence, not the gate; a destination reached under a different code is recorded "
         "as a discrepancy."),
        ("Live console",
         "Every run's console output is captured while the run is live and saved under "
         "automation/artifacts/e2e/console. It is the only place that states how many bundles "
         "committed, rolled back or were skipped."),
        ("Raised by the console",
         "'SQL dump failed' was logged on %d of %d runs. No downloaded artifact mentions it."
         % (sqlfail, len(runs))),
    ]
    for i, (k, v) in enumerate(rows):
        a, b = ov.cell(start + i, 1, k), ov.cell(start + i, 2, v)
        a.font = Font(size=11, bold=True, color="0F4C5C") if i == 0 else Font(size=10, bold=True)
        b.font = Font(size=10)
        b.alignment = WRAP
        if len(str(v)) > 90:
            ov.row_dimensions[start + i].height = 14 * (len(str(v)) // 88 + 1)
    ov.column_dimensions["B"].width = 104

    wb.save(WB)
    print("test cases updated :", written)
    for k in ("PASS", "FAIL", "BLOCKED", "OBSERVED"):
        print("   %-9s %3d" % (k, cnt[k]))
    print("   of the passes: %d rule-condition, %d routing" % (forced, routing))
    print("columns added      : Actual Destination, Verification Basis, Live Console")
    print("'SQL dump failed' logged on %d of %d runs" % (sqlfail, len(runs)))


if __name__ == "__main__":
    main()
