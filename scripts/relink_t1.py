# -*- coding: utf-8 -*-
"""Point the recovered rules at their new feed files and restate what to expect.

For the 11 rules recovered from Destination Detail (Java), the workbook still
names a destination spec file and carries the old "not drivable" caveat. This
replaces both, and writes the expected result from the Java column.
"""
import json
import os

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill

ROOT = r"C:\Users\RSERRANO\PRU ADB"
HERE = os.path.dirname(os.path.abspath(__file__))
WB = os.path.join(ROOT, "Test Data Scenarios for Demo", "PRU_ADB_E2E_Test_Scenarios_v4.xlsx")

IDX = json.load(open(os.path.join(HERE, "feed_index_t1.json")))
IDX.update(json.load(open(os.path.join(HERE, "feed_index_state.json"))))
ANA = json.load(open(os.path.join(HERE, "blocked_analysis.json")))

# rule -> (feed file, bundle entry)
WHERE = {}
for fn, e in IDX.items():
    for b in e["bundles"]:
        if b["br"].startswith("("):        # a setup bundle belongs to no rule
            continue
        WHERE[b["br"]] = (fn, b)

SMALL = Font(size=9)
WRAP = Alignment(wrap_text=True, vertical="top")
OK = PatternFill("solid", fgColor="E1F0E7")

wb = openpyxl.load_workbook(WB)
ws = wb["E2E Test Cases"]
n = 0
for r in range(4, ws.max_row + 1):
    rid = ws.cell(r, 2).value
    if not rid:
        continue
    rid = str(rid).strip()
    if rid not in WHERE:
        continue
    if str(ws.cell(r, 5).value or "").strip() == "Positive":
        # a positive case must stay on the valid baseline; these files carry faults
        continue
    fn, b = WHERE[rid]
    a = ANA.get(rid, {})

    ws.cell(r, 16).value = fn
    ws.cell(r, 17).value = "records %d-%d" % (b["recordStart"], b["recordStart"] + b["recordCount"] - 1)
    ws.cell(r, 11).value = a.get("how", b["note"])
    ws.cell(r, 20).value = a.get("expected", "")
    ws.cell(r, 18).value = ("LNA Report" if b.get("cls") == "fault injected"
                            and str(ws.cell(r, 13).value or "") else
                            "ADBSKIP" if "ADBSKIP" in a.get("expected", "")
                            else "CNTLRPT" if "ControlReport" in a.get("expected", "")
                            else "Activity extract" if "marker" in a.get("expected", "")
                            or "ActivityLogEntry" in a.get("expected", "")
                            else "LNA Report")
    ws.cell(r, 28).value = (
        "Recovered from Destination Detail (Java), %s. Condition: %s Trigger: %s "
        "If a different code is raised, record the actual code and check whether an earlier edit "
        "refused the record before this rule was reached - that is a finding about ordering, not "
        "necessarily a defect."
        % (a.get("tier", ""), a.get("condition", ""), a.get("how", "")))
    for c in (11, 16, 17, 18, 20, 28):
        ws.cell(r, c).font = SMALL
        ws.cell(r, c).alignment = WRAP
    ws.cell(r, 16).fill = OK
    n += 1
    print("  %-8s -> %s  %s" % (rid, fn, ws.cell(r, 17).value))

# record it on the Coverage Summary
cs = wb["Coverage Summary"]
nr = cs.max_row + 1
row = ["JAVA-01", "Rules recovered from Destination Detail (Java)", "11",
       "The 146 cases classed 'not drivable from the feed' were re-read against the Java "
       "destination column rather than the COBOL columns. 11 can be built after all: 8 as bundles "
       "in ALLSTATE.LNA.T1-JAVA-RECOVERED, and 3 header conditions as single-rule files "
       "(HDR-BR165-COMPANY, HDR-BR166-TRANSDATE, HDR-BR167-RECCOUNT). Expected results come from "
       "the Java column. Of the rest: 77 are SQL failures that no file can provoke and should be "
       "closed as out of scope, 36 need database state or the extract stage as input, 10 are "
       "shared routines already exercised by their callers, 4 govern the content of rows other "
       "cases already produce, 6 need two-phase execution, and 1 is BR-017 (Confidence C). "
       "Full working: PRU ADB - Blocked Rules Analysis.xlsx.", "Done"]
for i, v in enumerate(row, 1):
    c = cs.cell(nr, i, v)
    c.font = SMALL
    c.alignment = WRAP
cs.row_dimensions[nr].height = 120

wb.save(WB)
print("\nrelinked %d rules" % n)
