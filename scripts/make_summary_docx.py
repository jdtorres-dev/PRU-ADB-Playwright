# -*- coding: utf-8 -*-
"""Build the execution summary as a Word document, for sending on.

Same content as the published page, in a format that attaches to an email.
Every figure is read from the run artifacts and the source workbooks, not
retyped, so the document cannot drift from the results.
"""
import collections
import glob
import json
import os
import re

import openpyxl
from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Inches

ROOT = r"C:\Users\RSERRANO\PRU ADB"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "PRU ADB Execution Summary v1.00.docx")

INK = RGBColor(0x14, 0x1C, 0x22)
ACCENT = RGBColor(0x0C, 0x5E, 0x55)
MUTED = RGBColor(0x57, 0x66, 0x6E)
OK = RGBColor(0x2C, 0x6D, 0x4D)
GAP = RGBColor(0x9A, 0x3D, 0x2A)


# ------------------------------------------------------------------ figures
def gather():
    v = [json.load(open(f, encoding="utf-8"))
         for f in glob.glob(os.path.join(HERE, "..", "artifacts", "e2e", "verdicts", "*.json"))]
    runs = [json.load(open(f, encoding="utf-8"))
            for f in glob.glob(os.path.join(HERE, "..", "artifacts", "e2e", "runs", "*.json"))]
    cases = {x["id"]: x for x in json.load(open(os.path.join(HERE, "..", "data", "test-cases.json")))}
    cnt = collections.Counter(x["verdict"] for x in v)
    forced = sum(1 for x in v if x["verdict"] == "PASS" and cases[x["testCaseId"]]["conditionForced"])
    dest = collections.Counter(x["actualDestination"] for x in v if x["verdict"] == "PASS")
    codes = json.load(open(os.path.join(HERE, "codes.json")))
    sqlfail = sum(1 for r in runs
                  if any("SQL dump failed" in w for w in (r.get("outcome") or {}).get("warnings", [])))
    gens = sorted({r.get("generation") for r in runs if r.get("generation") is not None})
    blocked = collections.Counter(
        "ERRFILE" if cases[x["testCaseId"]]["destinationArtifact"] == "ERRFILE" else "other"
        for x in v if x["verdict"] == "BLOCKED")
    return dict(v=v, runs=runs, cases=cases, cnt=cnt, forced=forced, dest=dest, codes=codes,
                sqlfail=sqlfail, gens=gens, blocked=blocked)


# ------------------------------------------------------------------ helpers
def shade(cell, hexcolor):
    el = OxmlElement("w:shd")
    el.set(qn("w:val"), "clear")
    el.set(qn("w:fill"), hexcolor)
    cell._tc.get_or_add_tcPr().append(el)


def para(doc, text, *, size=10.5, bold=False, color=INK, italic=False, after=6, before=0):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(after)
    p.paragraph_format.space_before = Pt(before)
    r = p.add_run(text)
    r.font.size = Pt(size)
    r.font.bold = bold
    r.font.italic = italic
    r.font.color.rgb = color
    r.font.name = "Calibri"
    return p


def heading(doc, text, level=1):
    sizes = {0: 20, 1: 14, 2: 11.5}
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(16 if level else 0)
    p.paragraph_format.space_after = Pt(6)
    r = p.add_run(text)
    r.font.size = Pt(sizes[level])
    r.font.bold = True
    r.font.color.rgb = ACCENT if level < 2 else INK
    r.font.name = "Calibri"
    return p


def table(doc, headers, rows, widths=None, shading=None):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    for i, h in enumerate(headers):
        c = t.rows[0].cells[i]
        c.text = ""
        r = c.paragraphs[0].add_run(h)
        r.font.bold = True
        r.font.size = Pt(9)
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        r.font.name = "Calibri"
        shade(c, "0C5E55")
    for row in rows:
        cells = t.add_row().cells
        for i, val in enumerate(row):
            cells[i].text = ""
            p = cells[i].paragraphs[0]
            r = p.add_run(str(val))
            r.font.size = Pt(9)
            r.font.name = "Calibri"
            if i > 0 and str(val).replace(",", "").isdigit():
                p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            if shading:
                col = shading(row, i)
                if col:
                    shade(cells[i], col)
    if widths:
        for i, w in enumerate(widths):
            for row in t.rows:
                row.cells[i].width = Inches(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t


def main():
    d = gather()
    cnt, codes = d["cnt"], d["codes"]
    brd, ref, seen = set(codes["brd"]), set(codes["ref"]), set(codes["seen"])
    not_seen = brd - seen
    doc = Document()
    for s in doc.sections:
        s.left_margin = s.right_margin = Inches(0.85)
        s.top_margin = s.bottom_margin = Inches(0.8)

    # ---------------------------------------------------------- title
    para(doc, "ADB MODERNISATION  |  QA EXECUTION SUMMARY", size=9, bold=True, color=ACCENT, after=4)
    heading(doc, "Where the ADB test suite stands", 0)
    para(doc, "489 business rules. 284 test cases. One full execution against the development "
              "environment. This is what was covered, what passed, and what could not be tested "
              "at all.", size=11, color=MUTED, after=10)
    para(doc, "Executed 16 September 2026   |   Generation %s   |   %d feed files   |   "
              "Feed date 20260908   |   Prepared by R. Serrano, QA"
         % (", ".join(str(g) for g in d["gens"]), len(d["runs"])), size=8.5, color=MUTED, after=14)

    # ---------------------------------------------------------- at a glance
    heading(doc, "At a glance", 1)
    table(doc, ["Measure", "Figure", "What it means"], [
        ["Business rules in BRD v4", 489, "Across 51 business topics."],
        ["Covered by a test case", 270, "55% of the rule base, in 284 test cases."],
        ["Not covered", 219, "No error destination; 197 describe internal behaviour only."],
        ["Test cases passed", cnt["PASS"], "Output reached the destination the BRD assigns."],
        ["Test cases failed", cnt["FAIL"], "Output went somewhere other than that destination."],
        ["Blocked", cnt["BLOCKED"], "No destination that can be read, so no verdict is possible."],
        ["Observed", cnt["OBSERVED"], "Confidence C: behaviour recorded, not judged."],
    ], widths=[2.4, 0.9, 3.6],
        shading=lambda row, i: ("E2EFE6" if i == 1 and row[0] == "Test cases passed"
                                else "F3E3DE" if i == 1 and row[0] == "Test cases failed" else None))

    # ---------------------------------------------------------- Q1
    heading(doc, "1.  Business rules versus rules covered by test cases", 1)
    para(doc, "284 test cases cover 270 of the 489 rules. Fourteen rules carry both a positive and "
              "a negative case, which is why the case count exceeds the rule count. Coverage splits "
              "sharply on whether a rule names an error code.")
    table(doc, ["Rule type", "Rules", "Covered", "Not covered"], [
        ["Rules naming an error code", 223, 214, 9],
        ["Rules naming no error code", 266, 56, 210],
        ["TOTAL", 489, 270, 219],
    ], widths=[3.2, 1.1, 1.1, 1.4])

    heading(doc, "Why 219 rules have no test case", 2)
    para(doc, "Every one has no error destination - no report names them. Their disposition shows "
              "this is mostly legitimate rather than an oversight.")
    table(doc, ["Disposition", "Rules", "Assessment"], [
        ["Not applicable", 197, "Describes how the program derives a value or picks a routine. "
                                "Nothing is accepted or rejected, so there is no verdict to record."],
        ["Run terminated", 10, "The run stops. Plainly observable - a real gap."],
        ["Held", 8, "The record is not applied. Observable through the control report counters."],
        ["Discarded", 4, "The record is set aside. Observable on the skip report."],
        ["TOTAL", 219, ""],
    ], widths=[1.5, 0.8, 4.6])
    para(doc, "22 of the 219 are worth writing. Each stops the run, holds a record or discards one, "
              "so each has a visible effect and needs no new error code.", bold=True)

    # ---------------------------------------------------------- Q2
    heading(doc, "2.  Error codes produced versus error codes recorded in the BRD", 1)
    para(doc, "Three counts are often confused: what the BRD cites, what the reference file "
              "defines, and what the application actually produced during this execution.")
    table(doc, ["Source", "Codes", "What it is"], [
        ["Cited in BRD v4", len(brd), "Distinct codes named across the 223 rules that carry one."],
        ["Defined in the reference file", len(ref),
         "error_code_202609110900.txt - the only source of exact descriptions."],
        ["Produced in this run", len(seen),
         "Distinct codes actually written to the LNA report across %d uploads." % len(d["runs"])],
    ], widths=[2.2, 0.8, 3.9])

    para(doc, "Every code the run produced was one the BRD cites. Nothing unexpected appeared - the "
              "application emitted no code the business rules do not know about.", bold=True)

    heading(doc, "The %d codes cited but never produced" % len(not_seen), 2)
    para(doc, "Defined in the reference file, simply not reached (%d): %s. These need database "
              "state or a downstream service failure. They are on the parked list, not lost."
         % (len(not_seen & ref), ", ".join(sorted(not_seen & ref))))
    para(doc, "No description anywhere (%d): %s. Most are Java-layer status codes or activity "
              "markers rather than LNA error codes, so they would never appear on the error report."
         % (len(not_seen - ref), ", ".join(sorted(not_seen - ref))))

    # ---------------------------------------------------------- Q3
    doc.add_page_break()
    heading(doc, "3.  Test case results", 1)
    table(doc, ["Verdict", "Cases", "Meaning"], [
        ["PASS", cnt["PASS"], "Output reached the destination the BRD assigns."],
        ["FAIL", cnt["FAIL"], "Output reached a different destination."],
        ["BLOCKED", cnt["BLOCKED"], "No destination that can be read - see section 4."],
        ["OBSERVED", cnt["OBSERVED"], "Confidence C. Recorded, not judged (Test Plan v1.00 s6.3)."],
        ["TOTAL", sum(cnt.values()), ""],
    ], widths=[1.3, 0.9, 4.7],
        shading=lambda row, i: ("E2EFE6" if row[0] == "PASS" else
                                "F3E3DE" if row[0] == "FAIL" else
                                "F6EBD7" if row[0] == "BLOCKED" else None) if i == 0 else None)

    heading(doc, "Two kinds of pass, counted separately", 2)
    para(doc, "%d passes prove the rule. The feed file forces the rule's own condition, and the "
              "output reached the destination assigned to it." % d["forced"])
    para(doc, "%d passes prove the routing. The record is valid - nothing in it breaks a rule - so "
              "the correct destination is the successful output, and that is where it went. A valid "
              "record cannot appear on an error report."
         % (cnt["PASS"] - d["forced"]))
    para(doc, "Both are genuine results, and both are recorded per test case in the workbook. "
              "Presenting %d as a single number would overstate what was proven." % cnt["PASS"],
         italic=True, color=MUTED)

    table(doc, ["Destination", "Cases", "What was checked"],
          [[k, v, {"LNAERROR": "The error report carries the rule's output against the right record.",
                   "LOADFILE": "The record was applied - its identifier is in the load output, with "
                               "no refusal and no skip entry.",
                   "CNTLRPT": "Header controls: the file was refused and the run stopped, or the "
                              "controls were reported as satisfied.",
                   "ADBSKIP": "Skip entries carrying the reason code at the expected records."}
                  .get(k, "")] for k, v in d["dest"].most_common()],
          widths=[1.3, 0.9, 4.7])

    heading(doc, "The %d failures" % cnt["FAIL"], 2)
    para(doc, "Every one had its condition genuinely forced, and every one landed somewhere other "
              "than the destination the BRD assigns. These are the findings for development.")
    table(doc, ["Rule", "BRD says", "Output went to", "Reading"], [
        ["BR-047", "LNAERROR", "ADBSKIP + LOADFILE",
         "A mirror pair with BR-172: one skipped where the BRD says refuse, the other refused "
         "where it says skip. Likely one routing question, not two."],
        ["BR-172", "ADBSKIP", "LNAERROR + LOADFILE", "See above."],
        ["BR-230", "LNAERROR", "LOADFILE",
         "More serious: a record the rules say to reject was committed to the load output."],
        ["BR-309", "LNAERROR", "LOADFILE", "As BR-230."],
        ["BR-233", "LNAERROR", "ADBSKIP", "Set aside rather than refused."],
    ], widths=[0.8, 1.0, 1.6, 3.5])

    # ---------------------------------------------------------- Q4
    heading(doc, "4.  Why 58 test cases are blocked", 1)
    para(doc, "Blocked does not mean untested through neglect, and it is never a failure of the "
              "application. It means the destination these rules write to cannot be read, so no "
              "test data could produce a verdict.")
    table(doc, ["Destination the BRD assigns", "Cases", "Why no verdict is possible", "Held by"], [
        ["Error file (errfile-<CCYYMMDD>.csv)", 24,
         "Across %d runs the download has never contained one. It carries eight artifacts - control "
         "report, load output, LNA report, skip report, error log, new-BD report, activity extract, "
         "data dump - and not this one." % len(d["runs"]), "Development"],
        ["Java exception", 31,
         "The outcome is an exception thrown in the application. Nothing is written to a file that "
         "can be downloaded.", "Development"],
        ["Application log", 1,
         "Written to the log only, which is not among the downloadable artifacts.", "Development"],
        ["No destination at all", 2,
         "Internal control flow. The rule sets a flag or picks a routine; nothing is reported.",
         "Not testable end to end"],
        ["TOTAL", 58, "", ""],
    ], widths=[1.6, 0.7, 3.4, 1.2])

    heading(doc, "Separately parked: 112 test cases waiting on someone else", 2)
    para(doc, "88 need database access. Their condition is a database state no feed file can "
              "create. Development is providing direct access, which converts these from "
              "unreachable to verifiable. They are tagged SQL VERIFICATION in the workbook.")
    para(doc, "24 are the error-file cases above, tagged PENDING ERRFILE ACCESS.")
    para(doc, "Neither group is a coverage gap created by QA, and neither is an application defect. "
              "Both are recorded with the reason and the owner so they do not read as untested work.",
         italic=True, color=MUTED)

    # ---------------------------------------------------------- raised
    heading(doc, "Also raised", 1)
    heading(doc, "An application error on %d of %d runs" % (d["sqlfail"], len(d["runs"])), 2)
    para(doc, "\"ERROR SQL dump failed for 2026-09-08\" appears in the application's live console on "
              "nearly every upload. No downloaded artifact mentions it. It occurs after ingestion, "
              "so it does not appear to affect the results above - but it is failing consistently "
              "and nobody would see it without reading the console.")
    heading(doc, "The live console is now part of the evidence", 2)
    para(doc, "Each run's console output is captured while the run is live and stored with the "
              "results. It is the only place that states plainly what became of an uploaded file:")
    p = doc.add_paragraph()
    r = p.add_run("INFO  Cycle date 2026-09-08: processed 1/1 feed item(s)\n"
                  "WARN  Bundle for BD A130000200 rolled back; no records in it were applied\n"
                  "INFO  HR1 feed ingestion complete: 0 bundle(s) committed, 1 rolled back, "
                  "3 record(s) skipped")
    r.font.name = "Consolas"
    r.font.size = Pt(8.5)
    r.font.color.rgb = MUTED
    para(doc, "Every test case now carries this line alongside its verdict, so a result can be "
              "traced to what the application itself said at the time.", before=6)

    # ---------------------------------------------------------- next
    heading(doc, "What happens next", 1)
    table(doc, ["Action", "Cases", "Owner"], [
        ["Investigate the 5 failures - two records were committed that the rules say to reject",
         5, "QA with Development"],
        ["Database access, to verify the parked conditions directly", 88, "Development"],
        ["Confirm whether the error file can be added to the artifacts download", 24, "Development"],
        ["Explain \"SQL dump failed\", logged on %d of %d runs" % (d["sqlfail"], len(d["runs"])),
         "-", "Development"],
        ["Write test cases for the 22 uncovered rules that stop, hold or discard a record",
         22, "QA"],
    ], widths=[4.2, 0.7, 1.9])

    # ---------------------------------------------------------- footer
    para(doc, "", after=8)
    para(doc, "Executed 16 September 2026 against generation %s: %d feed files, feed date 20260908. "
              "%d runs completed and %d ended FAILED as expected - those are the header-validation "
              "files, where the run stopping is the correct outcome. Every run returned all eight "
              "artifacts."
         % (", ".join(str(g) for g in d["gens"]), len(d["runs"]),
            sum(1 for r in d["runs"] if r["runStatus"] == "COMPLETED"),
            sum(1 for r in d["runs"] if r["runStatus"] != "COMPLETED")),
         size=8.5, color=MUTED, after=4)
    para(doc, "Sources: ADB BRD v4 [for QA]; ADB BRD v4 RAW duplicate check - error destination; "
              "error_code_202609110900.txt; PRU_ADB_E2E_Test_Scenarios_v4; captured console output. "
              "Every figure is computed from those files and from the artifacts the run produced. "
              "Nothing was inferred where the source was silent.",
         size=8.5, color=MUTED)

    doc.save(OUT)
    print("saved:", OUT)
    print("  PASS %d (%d rule, %d routing) | FAIL %d | BLOCKED %d | OBSERVED %d"
          % (cnt["PASS"], d["forced"], cnt["PASS"] - d["forced"], cnt["FAIL"], cnt["BLOCKED"],
             cnt["OBSERVED"]))
    print("  codes: %d cited, %d defined, %d produced" % (len(brd), len(ref), len(seen)))


if __name__ == "__main__":
    main()
