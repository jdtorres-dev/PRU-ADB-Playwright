# -*- coding: utf-8 -*-
"""Work the 146 blocked rules against Destination Detail (Java).

Groups A-D come straight from the Java column. Group E (54) is decided rule by
rule below: can the condition be created by the file we upload, and if so, how.

Nothing here is derived from the COBOL columns. The system under test is the
modernised Java, so Data Field(s), Source Program, Source Paragraph, Source
Lines and Source Code Excerpt are traceability only.
"""
import json
import os
import collections

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

ROOT = r"C:\Users\RSERRANO\PRU ADB"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "PRU ADB - Blocked Rules Analysis.xlsx")

# T1  create the condition inside the feed file we already upload
# T1H the condition lives on the submitting header, so it needs its own file
# T1A no new data - assert it on a run we already make
# T2  two-phase: one upload commits state, a second presents the condition
# T3  not reachable from the feed at all - needs database state or another input
DECISION = {
    # ---- T1 : set a field or shape a record in the uploaded file -----------
    "BR-009": ("T1", "Producer record carrying a sub-type that is neither of the two recognised values.",
               "Set the record type/sub-type to D03 on an otherwise valid producer record.",
               "ADBSKIP entry with SkipReasonCode 001 INVALID_RECORD_TYPE. No LNAERROR row."),
    "BR-169": ("T1", "Record whose type/sub-type is outside B, C, D01, D02, Z.",
               "Insert a record whose first position is X inside an otherwise valid bundle.",
               "ADBSKIP entry, SkipReasonCode 001. No LNAERROR row."),
    "BR-172": ("T1", "A producer profile is expected but a producer entity record arrives instead.",
               "Repeat the D01 record where the D02 belongs.",
               "ADBSKIP entry, SkipReasonCode 001. No LNAERROR row."),
    "BR-015": ("T1", "Any refusal on the contra header suppresses the whole bundle beneath it.",
               "Blank the firm name on the B record (a known refusal), then let the bundle's C, D01, "
               "D02 follow normally.",
               "Every record drained to the next contra header appears on ADBSKIP with "
               "SkipReasonCode 002 EARLIER_BUNDLE_RECORD_FAILED."),
    "BR-047": ("T1", "A producer profile record arrives next while the bundle is not marked as a new "
                     "broker dealer bundle.",
               "Present a D02 immediately after the contra header, with no firm entity record.",
               "LnaValidationErrorEntry via RecordOutcome.Rejected - the record is refused to LNAERROR."),
    "BR-309": ("T1", "Profile type H presented where no investment professional relationship exists.",
               "Set the profile type to H on a producer profile carrying identifiers never presented "
               "before - no relationship can exist for them.",
               "OperationStatus 0001 VALIDATION_FAILURE on AppointmentResult; P2721 written to LNAERROR."),
    "BR-038": ("T1", "Any organisation or relationship created or amended produces an activity entry.",
               "A valid bundle that creates a new organisation. No fault needed.",
               "ActivityLogEntry carrying ORO0OR on the extract. Assert the entry exists, not an error."),
    "BR-057": ("T1", "Every firm or producer presented for appointment produces an appointment marker.",
               "A valid bundle carrying a producer profile. No fault needed.",
               "Activity marker AP00AP on the extract."),

    # ---- T1A : assert on a run we already make, no new data ----------------
    "BR-014": ("T1A", "Throughout the run, six outputs are produced.",
               "No new data. Assert against any completed run.",
               "All six HR1 artifacts present in the download: CNTLRPT, LOADFILE, LNAERROR, NEWBD, "
               "ADBSKIP, ADBERROR."),

    # ---- T1H : condition lives on the submitting header --------------------
    "BR-165": ("T1H", "The company name on the submitting header does not match the name supplied to "
                      "the job.",
               "A single-rule file whose header carries a different company name.",
               "ControlReport.forHeaderValidationFailure(company), then InterfaceValidationException. "
               "No records processed."),
    "BR-166": ("T1H", "The transmission date on the header does not equal the cycle date.",
               "A single-rule file whose header transmission date differs from the Feed Date set in "
               "the console. Only compared when the date check is switched on.",
               "ControlReport.forHeaderValidationFailure(date), then InterfaceValidationException."),
    "BR-167": ("T1H", "The record count declared on the header does not match the external count.",
               "A single-rule file whose header count is deliberately one too many.",
               "ControlReport.forHeaderValidationFailure(count), then InterfaceValidationException."),

    # ---- T2 : needs a prior run to commit the state ------------------------
    "BR-141": ("T2", "A firm is presented for an organisation that already exists.",
               "Upload a bundle, let it commit, then present the same identifiers again.",
               "OperationStatus 0002 DATA_INCONSISTENCY on OrganizationResult; O2711 to LNAERROR and "
               "a row on ADBERROR."),
    "BR-267": ("T2", "A caller-supplied classification field differs from the organisation row already "
                     "held.",
               "Commit a bundle, then re-present the same organisation with a different firm type.",
               "OperationStatus 0002 DATA_INCONSISTENCY; O2711 to LNAERROR and ADBERROR."),
    "BR-039": ("T2", "The relationship status on the incoming record differs from the status held.",
               "Commit a profile as active, then re-present it as terminated.",
               "Activity marker TE00TE (termination) or RA00RA (reappointment) on the extract."),
    "BR-040": ("T2", "The relationship start or end date differs from that held, status unchanged.",
               "Commit a profile, then re-present it with a different start date.",
               "Activity marker MI00MI on the extract."),
    "BR-137": ("T2", "A producer with activity on one contract and holding more than one.",
               "Commit a producer against two firms, then present activity on one of them.",
               "MI00MI no-change marker entries for the untouched contract "
               "(HrActivityExtractService.buildNoActivityMarkers)."),
    "BR-301": ("T2", "A generated contract number already exists, so the generator loops.",
               "Commit enough contracts to force a collision. Depends on the generator's sequence, so "
               "confirm the algorithm before planning this.",
               "OperationStatus 0002 DATA_INCONSISTENCY on AppointmentResult; P2721 to LNAERROR."),
}

# Everything else in group E: not reachable from the file we upload.
T3_REASONS = {
    "extract": ("T3", "The input to this stage is the activity extract, not the LNA feed we upload. "
                      "Reaching it means driving the extract stage, which the console does not expose.",
                "ActivityErrorEntry on errfile-detectchanges-<CCYYMMDD>.csv."),
    "notfound": ("T3", "The condition is a database read returning no row. A feed file cannot remove a "
                       "row that the service expects to find.",
                 "RecordBuildResult 0001 / 0002 returned to UTP27901, recorded as D003 on the error file."),
    "sqlstate": ("T3", "The condition is a specific SQL state (duplicate rows, control-row contention). "
                       "It needs the database put into that state deliberately.",
                 "OperationStatus 0002 DATA_INCONSISTENCY; O2711 or P2721 to LNAERROR."),
    "reftable": ("T3", "The condition is a malformed value on a reference table the service reads. It "
                       "is not carried on the input record.",
                 "OperationStatus 0002 DATA_INCONSISTENCY; O2711 to LNAERROR and ADBERROR."),
    "param": ("T3", "The condition is a job parameter, not a field on the feed file. The console does "
                    "not expose it.",
              "Control-report line only."),
    "masked": ("T3", "The field is not on the LNA input layout - it is derived inside the service. "
                     "And where a comparable field is on the layout, the LNA edit refuses the record "
                     "first, so the service-level rule is never reached.",
               "OperationStatus 0001 VALIDATION_FAILURE; O2711 or P2721 to LNAERROR - not reachable "
               "from a feed file."),
}
T3_MAP = {
    "BR-374": "extract", "BR-375": "extract", "BR-378": "extract", "BR-382": "extract",
    "BR-383": "extract", "BR-384": "extract", "BR-386": "extract", "BR-049": "extract",
    "BR-073": "notfound", "BR-077": "notfound", "BR-079": "notfound", "BR-090": "notfound",
    "BR-093": "notfound", "BR-099": "notfound", "BR-113": "notfound", "BR-115": "notfound",
    "BR-441": "notfound", "BR-457": "notfound", "BR-248": "notfound", "BR-249": "notfound",
    "BR-258": "sqlstate", "BR-262": "sqlstate", "BR-265": "sqlstate", "BR-266": "sqlstate",
    "BR-361": "sqlstate", "BR-362": "sqlstate", "BR-071": "sqlstate",
    "BR-275": "reftable", "BR-276": "reftable", "BR-280": "reftable", "BR-281": "reftable",
    "BR-255": "reftable",
    "BR-004": "param",
    # The person/firm indicator and the organisation code are not fields on the LNA
    # input layout - they are derived inside the service. And even where a field is
    # on the layout, the LNA edit refuses the record before the service is called,
    # so the service-level rule never runs.
    "BR-254": "masked", "BR-289": "masked", "BR-370": "masked",
}


def load():
    w = openpyxl.load_workbook(os.path.join(ROOT, "ADB BRD v4 RAW  duplicate check - error destination.xlsx"),
                               data_only=True)["Business Rules"]
    b = openpyxl.load_workbook(os.path.join(ROOT, "ADB BRD v4 [for QA] (1).xlsx"),
                               data_only=True)["Business Rules"]
    J = {}
    for r in range(2, 1001):
        rid = w.cell(r, 2).value
        if rid:
            J[str(rid).strip()] = (str(w.cell(r, 24).value or "").strip(),
                                   str(w.cell(r, 23).value or "").strip())
    B = {}
    for r in range(2, 491):
        rid = str(b.cell(r, 2).value or "").strip()
        if rid:
            B[rid] = dict(topic=str(b.cell(r, 6).value or ""), rule=str(b.cell(r, 7).value or ""),
                          cond=str(b.cell(r, 8).value or ""), thr=str(b.cell(r, 10).value or ""),
                          prog=str(b.cell(r, 15).value or ""), conf=str(b.cell(r, 13).value or ""))
    return J, B


def group_of(java):
    t = java.lower()
    if "sql_failure" in t:
        return "A"
    if "shared edit routine" in t or "shared code-decode" in t or "lookup itself writes nothing" in t:
        return "B"
    if "governs the" in t or t.startswith("governs"):
        return "C"
    if "contradiction" in t:
        return "D"
    return "E"


GROUP_TEXT = {
    "A": ("Confirm the path exists - described in legacy terms",
          "The column describes this as OperationStatus 0003 SQL_FAILURE and names a COBOL program. "
          "The modernised process has no SQL, so the wording is carried from the legacy analysis "
          "rather than describing Java behaviour. 77 of 77 such rows cite a COBOL program name; "
          "only 1 of the 12 rows that could actually be built does. The described error path may "
          "not exist in the modernised system at all.",
          "Refer to the development team: does this path exist in the Java, and under what "
          "condition? If it does not, the rule is obsolete and should be withdrawn, not left open."),
    "B": ("Covered by proxy - shared routine",
          "The Java says the routine writes nothing of its own; the calling edit emits the row under "
          "its own code. It therefore runs inside every calling rule's test.",
          "Record as covered by proxy, naming the callers. No new test data."),
    "C": ("Assertion on an existing row",
          "The rule governs the content of a row another test already produces, not whether one is "
          "written.",
          "Add an assertion to the cases that already generate those rows. No new test data."),
    "D": ("Observe only - Confidence C",
          "BRD v4 marks the rule Confidence C: the source contradicts itself, so no expected result "
          "can be stated.",
          "Already recorded OBSERVED under QA Test Plan v1.00 section 6.3."),
}
TIER_TEXT = {
    "T1": "Feed-drivable - build the condition into a feed file",
    "T1A": "No new data - assert on a run we already make",
    "T1H": "Feed-drivable - needs a single-rule file (header condition)",
    "T2": "Two-phase - one run commits, the next presents the condition",
    "T3": "Not reachable from the feed",
}


def main():
    J, B = load()
    cases = json.load(open(os.path.join(HERE, "..", "data", "test-cases.json")))
    carrier = [x["rule"] for x in cases if not x["executable"] and "carrier" in x["blockedReason"]]
    # Rules recovered into feed files are no longer "blocked" in the registry, but they
    # belong to this analysis: it is the record of how each of the 146 was decided.
    for rid in DECISION:
        if rid not in carrier:
            carrier.append(rid)

    rows, stats = [], collections.Counter()
    for rid in carrier:
        java, dest = J[rid]
        g = group_of(java)
        if g == "E":
            if rid in DECISION:
                tier, cond, how, expect = DECISION[rid]
            else:
                key = T3_MAP.get(rid)
                if not key:
                    tier, cond, how, expect = ("T3", B[rid]["cond"],
                                               "Not yet decided - review individually.", java)
                else:
                    tier, reason, expect = T3_REASONS[key]
                    cond, how = B[rid]["cond"], reason
            outcome = TIER_TEXT[tier]
        else:
            label, why, action = GROUP_TEXT[g]
            tier = {"A": "CONFIRM", "B": "PROXY", "C": "ASSERT", "D": "OBSERVE"}[g]
            cond, how, expect, outcome = B[rid]["cond"], why, java, action
        stats[tier] += 1
        rows.append([rid, g, tier, outcome, B[rid]["topic"], B[rid]["rule"], cond, how, expect,
                     dest, java, B[rid]["prog"], B[rid]["conf"]])

    order = {"T1": 0, "T1H": 1, "T1A": 2, "T2": 3, "ASSERT": 4, "PROXY": 5, "OBSERVE": 6,
             "T3": 7, "CONFIRM": 8}
    rows.sort(key=lambda r: (order.get(r[2], 9), r[0]))

    # ------------------------------------------------------------- workbook
    HDR = PatternFill("solid", fgColor="0F4C5C")
    HDRF = Font(color="FFFFFF", bold=True, size=10)
    SMALL = Font(size=9)
    WRAP = Alignment(wrap_text=True, vertical="top")
    THIN = Side(style="thin", color="D3DDE1")
    BORD = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
    BAND = {"T1": "E1F0E7", "T1H": "E1F0E7", "T1A": "E1F0E7", "T2": "FFF4E5", "ASSERT": "EAF0F6",
            "PROXY": "EAF0F6", "OBSERVE": "EAF0F6", "T3": "F5F5F5", "CONFIRM": "FBE9E7"}

    wb = openpyxl.Workbook()
    s = wb.active
    s.title = "Blocked Rules Analysis"
    s["A1"] = "The 146 blocked rules, worked against Destination Detail (Java)"
    s["A1"].font = Font(bold=True, size=15, color="0F4C5C")
    s["A2"] = ("Ordered by what can be done about them. Nothing here is derived from the COBOL "
               "columns: the system under test is the modernised Java, so Data Field(s), Source "
               "Program, Source Paragraph, Source Lines and Source Code Excerpt are traceability only.")
    s["A2"].font = Font(italic=True, size=9.5, color="555555")
    s.merge_cells("A2:H2")
    s["A2"].alignment = WRAP
    s.row_dimensions[2].height = 28

    H = ["Rule", "Group", "Tier", "What can be done", "Business Topic", "Business Rule",
         "Condition to create", "How to create it", "Expected result (from the Java column)",
         "Error Destination", "Destination Detail (Java)", "Source Program (traceability only)",
         "Confidence"]
    W = [10, 7, 9, 40, 26, 62, 56, 62, 62, 26, 62, 20, 11]
    for i, h in enumerate(H, 1):
        c = s.cell(4, i, h)
        c.fill = HDR
        c.font = HDRF
        c.border = BORD
        c.alignment = Alignment(wrap_text=True, vertical="center")
        s.column_dimensions[get_column_letter(i)].width = W[i - 1]
    s.row_dimensions[4].height = 30

    for r, row in enumerate(rows, 5):
        for i, v in enumerate(row, 1):
            c = s.cell(r, i, v)
            c.font = SMALL
            c.alignment = WRAP
            c.border = BORD
            c.fill = PatternFill("solid", fgColor=BAND.get(row[2], "FFFFFF"))
        s.row_dimensions[r].height = 46
    s.freeze_panes = "A5"
    s.auto_filter.ref = "A4:M%d" % (4 + len(rows))

    # ----------------------------------------------------------- summary
    sm = wb.create_sheet("Summary", 0)
    sm.column_dimensions["A"].width = 12
    sm.column_dimensions["B"].width = 46
    sm.column_dimensions["C"].width = 10
    sm.column_dimensions["D"].width = 92
    sm["A1"] = "What the Java column says we can do with the 146"
    sm["A1"].font = Font(bold=True, size=15, color="0F4C5C")
    for i, h in enumerate(["Tier", "Meaning", "Rules", "Action"], 1):
        c = sm.cell(3, i, h)
        c.fill = HDR
        c.font = HDRF
        c.border = BORD
    ACTION = {
        "T1": "Build the condition into a feed file. Expected result already known.",
        "T1H": "Three single-rule files, one per header condition.",
        "T1A": "No new data. Assert the six outputs on any completed run.",
        "T2": "Two-phase execution: one upload commits, the next presents the condition.",
        "ASSERT": "Add assertions to cases that already produce those rows.",
        "PROXY": "Record as covered by proxy, naming the calling rules.",
        "OBSERVE": "Already OBSERVED under Test Plan section 6.3.",
        "T3": "Not reachable from the feed. Needs database state or the extract stage as input.",
        "CONFIRM": "Ask the development team whether this error path exists in the Java at all. "
                   "The wording is carried from the legacy analysis.",
    }
    r = 4
    for t in sorted(stats, key=lambda x: order.get(x, 9)):
        for i, v in enumerate([t, TIER_TEXT.get(t, GROUP_TEXT.get(
                {"CONFIRM": "A", "PROXY": "B", "ASSERT": "C", "OBSERVE": "D"}.get(t, "A"), ("", "", ""))[0]),
                stats[t], ACTION[t]], 1):
            c = sm.cell(r, i, v)
            c.font = SMALL if i != 1 else Font(size=10, bold=True)
            c.alignment = WRAP
            c.border = BORD
            c.fill = PatternFill("solid", fgColor=BAND.get(t, "FFFFFF"))
        sm.row_dimensions[r].height = 30
        r += 1
    for i, v in enumerate(["TOTAL", "", sum(stats.values()), ""], 1):
        c = sm.cell(r, i, v)
        c.font = Font(size=10, bold=True)
        c.border = BORD

    wb.save(OUT)
    json.dump({x[0]: dict(group=x[1], tier=x[2], condition=x[6], how=x[7], expected=x[8])
               for x in rows}, open(os.path.join(HERE, "blocked_analysis.json"), "w"), indent=1)

    print("saved:", OUT)
    for t in sorted(stats, key=lambda x: order.get(x, 9)):
        print("   %-8s %3d  %s" % (t, stats[t], ACTION[t][:62]))
    print("   %-8s %3d" % ("TOTAL", sum(stats.values())))


if __name__ == "__main__":
    main()
