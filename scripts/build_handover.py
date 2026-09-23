# -*- coding: utf-8 -*-
"""Assemble everything a tester needs to run this suite, into PRU ADB Files.

Copies the automation, the test case workbook, the feed files and the reference
material, and writes a README that says how to run it and what to watch for.
Excludes node_modules and the 80 MB of downloaded artifacts - the first is
installed, the second is produced.
"""
import json
import os
import shutil

ROOT = r"C:\Users\RSERRANO\PRU ADB"
HERE = os.path.dirname(os.path.abspath(__file__))
AUT = os.path.join(ROOT, "automation")
OUT = os.path.join(ROOT, "PRU ADB Files")

COPY = [
    # (source, destination inside the package)
    (os.path.join(AUT, "package.json"), "automation/package.json"),
    (os.path.join(AUT, "package-lock.json"), "automation/package-lock.json"),
    (os.path.join(AUT, "playwright.config.ts"), "automation/playwright.config.ts"),
    (os.path.join(AUT, "tsconfig.json"), "automation/tsconfig.json"),
    (os.path.join(AUT, "README-E2E.md"), "automation/README-E2E.md"),
]
DIRS = [
    (os.path.join(AUT, "src"), "automation/src", (".ts",)),
    (os.path.join(AUT, "tests"), "automation/tests", (".ts",)),
    (os.path.join(AUT, "data"), "automation/data", (".json",)),
    (os.path.join(AUT, "scripts"), "automation/scripts", (".py", ".json")),
    (os.path.join(ROOT, "E2E Test Data"), "Test Data", (".txt",)),
    (os.path.join(AUT, "artifacts", "e2e", "console"), "Evidence/console", (".log",)),
    (os.path.join(AUT, "artifacts", "e2e", "verdicts"), "Evidence/verdicts", (".json",)),
    (os.path.join(AUT, "artifacts", "e2e", "runs"), "Evidence/runs", (".json",)),
]
FILES = [
    (os.path.join(ROOT, "Test Data Scenarios for Demo", "PRU_ADB_E2E_Test_Scenarios_v4.xlsx"),
     "Test Cases/PRU_ADB_E2E_Test_Scenarios_v4.xlsx"),
    (os.path.join(ROOT, "PRU ADB - Blocked Rules Analysis.xlsx"),
     "Test Cases/PRU ADB - Blocked Rules Analysis.xlsx"),
    (os.path.join(ROOT, "PRU ADB QA Test Plan v1.00.docx"),
     "Test Cases/PRU ADB QA Test Plan v1.00.docx"),
    (os.path.join(ROOT, "PRU ADB Execution Summary v1.00.docx"),
     "PRU ADB Execution Summary v1.00.docx"),
    (os.path.join(ROOT, "ADB BRD v4 [for QA] (1).xlsx"),
     "Reference/ADB BRD v4 [for QA].xlsx"),
    (os.path.join(ROOT, "ADB BRD v4 RAW  duplicate check - error destination.xlsx"),
     "Reference/ADB BRD v4 RAW duplicate check - error destination.xlsx"),
    (os.path.join(ROOT, "error_code_202609110900.txt"),
     "Reference/error_code_202609110900.txt"),
    (os.path.join(ROOT, "Testing Files", "ADB Allstate LNA Input File Layout - HR.xlsx"),
     "Reference/ADB Allstate LNA Input File Layout - HR.xlsx"),
]

README = """# PRU ADB - E2E test suite

Everything needed to run the BRD v4 suite against the HR Master Console, and the
evidence from the last execution.

Last run: **16 September 2026, generation 13** - 85 feed files, 284 test cases,
220 passed, 5 failed, 58 blocked, 1 observed.

---

## What is here

| Folder | What it holds |
|---|---|
| `automation/` | The Playwright suite: page object, validator, specs, registry, build scripts |
| `Test Cases/` | The test case workbook (the definition of record), the blocked-rule analysis, the QA test plan |
| `Test Data/` | {feeds} LNA feed files plus their manifests - the data uploaded during the run |
| `Reference/` | BRD v4, the error-code reference, the input file layout |
| `Evidence/` | What the last run produced: per-case verdicts, per-feed run records, captured console output |

`node_modules` is not included - install it. The downloaded artifact ZIPs are not
included either; they are produced by the run and come to about 80 MB.

---

## First run

```bash
cd automation
npm install
npx playwright install chromium
```

Two paths in the scripts point at this machine. Change them if the package moves:

- `ROOT` at the top of each file in `automation/scripts/`
- `DATA_ROOT` / feed paths in `automation/data/feeds.json` (rebuilt by `build_registry.py`)

---

## Running it

```bash
# 1. Issue a fresh generation. MANDATORY - see "No data reset" below.
python scripts/reissue_e2e.py 14

# 2. Upload every feed file and download its artifacts.   (~10 min)
npm run e2e:execute

# 3. Judge all 284 test cases. Touches nothing; re-runnable. (~30 sec)
npm run e2e:validate

# 4. Write the verdicts into the workbook.
python scripts/write_results.py
```

`npm run e2e:plan` lists what step 2 would upload, without uploading anything.
To run one feed file: `npx playwright test --project=e2e-execute --grep "B0607"`.

---

## No data reset

The environment never resets. A bundle whose firm record passes validation
commits its organisation, and presenting the same identifiers again raises
**B0700** instead of the condition under test.

`reissue_e2e.py <n>` rebuilds every feed file with generation-`n` identifiers, so
no bundle anywhere shares an identifier with any previous run. Run it immediately
before an execution, never during one. The execution phase refuses to start
without `data/generation.json`.

**Generations 1-13 are spent.** Start at 14.

---

## How a verdict is decided

The test is whether output landed at the destination the BRD assigns - not
whether a particular error code fired.

- **The feed forces the rule's condition** -> the output must reach that rule's
  destination. A pass here proves the rule. 101 of the last run's passes.
- **The record is valid** -> the right destination is the successful output. A
  valid record cannot appear on an error report, so being applied is correct.
  A pass here proves routing, not the rule. 119 of the last run's passes.

The expected error code is evidence, not the gate. Output reaching its
destination under a different code is recorded as a discrepancy, not a failure.

Three rules override everything above:

1. A Confidence C rule is **OBSERVED** - recorded, never passed or failed
   (QA Test Plan v1.00 section 6.3).
2. A case with no readable destination is **BLOCKED**, never FAIL.
3. An automation or environment failure is **BLOCKED**, never FAIL.

---

## The 284 test cases in TypeScript

The suite is data-driven: `tests/e2e-02-validate.spec.ts` reads
`data/test-cases.json` and generates one Playwright test per case, so the
workbook stays the single definition of record.

`tests/test-cases.generated.ts` mirrors all 284 as typed constants, for reading
and searching in an editor. Rebuild it with `python scripts/gen_ts_cases.py`.
It is generated - do not hand-edit.

---

## Known state at handover

| | |
|---|---|
| **5 failures** | BR-047, BR-172, BR-230, BR-233, BR-309. Each landed at a destination other than the assigned one. BR-230 and BR-309 were committed to the load output when the rules say to reject them. |
| **58 blocked** | 24 write to `errfile-<CCYYMMDD>.csv`, which has never appeared in any download. 31 to a Java exception, 1 to the log, 2 to nothing. No test data changes this. |
| **88 parked** | Need direct database access, tagged `SQL VERIFICATION` in the workbook. |
| **`SQL dump failed`** | Logged on 79 of 85 runs, in the console only. Raised with development. |

---

## The live console

The console at `/api/v1/ingestion/runs/{runId}/logs` is the only place that says
what became of an uploaded file:

```
INFO  HR1 feed ingestion complete: 0 bundle(s) committed, 1 rolled back, 3 record(s) skipped
```

**It is only available while the run is live** - a completed run returns 404. The
execution phase polls it during the run and saves the output to
`artifacts/e2e/console/`. Every verdict quotes the summary line.
"""


def main():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    copied = 0
    for src, rel in COPY + FILES:
        if not os.path.exists(src):
            print("  MISSING, skipped:", os.path.basename(src))
            continue
        dst = os.path.join(OUT, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1

    per_dir = {}
    for src, rel, exts in DIRS:
        if not os.path.isdir(src):
            print("  MISSING directory, skipped:", src)
            continue
        n = 0
        for name in sorted(os.listdir(src)):
            if not name.lower().endswith(exts):
                continue
            dst = os.path.join(OUT, rel.replace("/", os.sep), name)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(src, name), dst)
            n += 1
        per_dir[rel] = n
        copied += n

    feeds = per_dir.get("Test Data", 0)
    open(os.path.join(OUT, "README.md"), "w", encoding="utf-8").write(
        README.replace("{feeds}", str(feeds)))

    total = sum(os.path.getsize(os.path.join(dp, f))
                for dp, _, fs in os.walk(OUT) for f in fs)
    print("package: %s" % OUT)
    print("files copied: %d   total size: %.1f MB" % (copied + 1, total / 1e6))
    for rel, n in sorted(per_dir.items()):
        print("   %-24s %3d" % (rel, n))


if __name__ == "__main__":
    main()
