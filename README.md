# PRU ADB Playwright — E2E automation (BRD v4)

Playwright + TypeScript automation for the **PRU ADB HR Master Console**. It
logs in, sets the feed date, uploads a feed file, waits for the ingestion run
to settle, downloads the General Artifacts ZIP, reads the artifacts inside it,
and decides a verdict for every test case in the BRD v4 registry.

This project was built from a reference implementation (`automation/` in the
supplied package) as a clean rewrite: Page Object Model, typed data loaders,
the judging logic pulled out of the test files, and two real correctness
fixes found while reading the reference (see *What changed from the
reference implementation* below). It does not carry any of its own copy of an
expected error code, description or destination — everything is read from
`data/test-cases.json` and `data/feeds.json`, generated from the BRD v4
workbook.

**Nothing here has been executed against the live environment yet.** See
*Execution status* at the bottom.

## ⚠️ IMPORTANT — Test flow, step by step

Both suites (the original 85-feed suite and the BRv4 suite) follow the same
sequence: **login → set feed date → upload feed → wait for the run to settle
→ download the artifacts ZIP → judge each test case**. Upload (execute) and
judging (validate) are separate phases.

> **The environment has no data reset.** A committed feed can never be
> presented again with the same identifiers — doing so raises **B0700**
> instead of the rule under test. Never re-upload positive/setup feeds
> casually, and never run uploads in parallel (the configs already force
> `workers: 1`, `retries: 0`).

### A. Manual testing (browser)

1. Open `BASE_URL` (default
   `https://pru-adb-dev.ap-southeast-1.elasticbeanstalk.com`) and accept the
   certificate warning (the dev host's certificate is not trusted).
2. Log in with `ADB_USERNAME` / `ADB_PASSWORD` from `.env`.
3. Open the **Upload** tab.
4. Set **Feed Date** to the date in the feed filename — e.g.
   `...D20260908.txt` → `20260908`. For multi-day rules
   (`BR-031-DAY1/2/3`, `BR-050-DAY1/2`, …) each day's file carries its own
   date (`D20260908`, `D20260909`, `D20260910`).
5. Choose the file from `data/feeds/`, in the order listed in
   `data/feeds.brv4.json` (BRv4) or `data/feeds.json` (original). A rule's
   `setup` / `DAY1` / `CANDIDATE` feed must go **before** its `TRIGGER` /
   `DAY2` feed.
6. Click **Upload** and note the **Run ID**.
7. Watch the Live console until the status leaves
   `ACCEPTED` / `IN_PROGRESS` / `RUNNING` (can take a few minutes).
8. Enter the Run ID → **Lookup** → **General Artifacts → ALL (.zip)**.
9. Compare the artifacts with the case in `data/test-cases.brv4.json` (or
   `data/test-cases.json`):
   - **Negative** — the `expectedCode` appears in the LNA error report
     against that bundle. A *different* code firing is a `FAIL` (possible
     masking).
   - **Positive** — no refusal **and** the broker-dealer identifier is in the
     LOADFILE.
   - **CNTLRPT** — either the header is refused, or the controls are
     reported satisfied.
10. DB-verified cases only: confirm the result in Postgres (e.g.
    `pru_adb.activity_log_entry`, `adsi_master.master_control`) using the
    `host` / `port` / `user` / `pass` / `database` keys in `.env`.

### B. Playwright

**One-time setup**

```bash
npm install
npx playwright install chromium
cp .env.example .env    # BASE_URL, ADB_USERNAME, ADB_PASSWORD, FEED_DATE (+ DB keys for BRv4)
npm run typecheck
```

**Step 1 — Smoke-test the framework (safe to repeat)**

```bash
npx playwright test --project=smoke --grep "verdict"   # offline unit tests of the judging logic
npx playwright test --project=smoke --grep "login"     # live login only, uploads nothing
npm run test:smoke                                      # all smoke tests, incl. one negative feed (TC-BR-018)
```

Add `--headed` to watch the browser, or `--debug` to step through with the
Playwright Inspector.

**Step 2a — Original suite (85 feeds / 284 cases)**

```bash
npm run e2e:execute:plan    # list what would be uploaded (uploads nothing)
npm run e2e:execute         # upload every feed → artifacts/e2e/runs/
npm run e2e:validate        # judge every case; touches nothing, re-runnable
npm run report:build        # artifacts/e2e/reports/traceability-report.csv + summary.md
```

**Step 2b — BRv4 suite** (separate config, no npm shortcuts — always pass
`-c playwright.brv4.config.ts`)

```bash
# see the plan
npx playwright test -c playwright.brv4.config.ts --project=e2e-execute-brv4 --list

# 1. execute — uploads feeds in data/feeds.brv4.json order → artifacts/e2e-brv4/runs/
npx playwright test -c playwright.brv4.config.ts --project=e2e-execute-brv4

# 2. validate (offline)
npx playwright test -c playwright.brv4.config.ts --project=e2e-validate-brv4

# 3. DB-verified cases (seed → run a cycle → assert in Postgres)
npx playwright test -c playwright.brv4.config.ts --project=e2e-db-brv4

# 4. reports
npx playwright show-report playwright-report-brv4
node scripts/regen-final-report-brv4.js     # artifacts/reports/final-verdict-report-brv4.{csv,xlsx}
```

Running with no `--project` (or the top-level run button in UI mode) runs
all three projects **one test at a time, in the order above** — the config
pins `workers: 1`, and projects run in the order they are listed. Only do
that against a clean DB: step 1 re-uploads the feeds.

For interactive runs use UI mode:
`npx playwright test -c playwright.brv4.config.ts --ui` (the VS Code
extension panel does not load this config reliably).

> `tests/e2e-brv4/_cleanup-stuck-queue.spec.ts` performs a direct DB
> `UPDATE`. It belongs to no project, so it never runs as part of a normal
> execution; enable it explicitly with `BRV4_MAINTENANCE=1` (project
> `maintenance-brv4`).

**Run a single feed or test case**

```bash
# upload one feed only
npx playwright test -c playwright.brv4.config.ts --project=e2e-execute-brv4 --grep "BR-022"

# judge one case only (needs that feed's run record from the execute phase)
npx playwright test -c playwright.brv4.config.ts --project=e2e-validate-brv4 --grep "TC-BR-022"

# run one DB-verified case only
npx playwright test -c playwright.brv4.config.ts --project=e2e-db-brv4 --grep "TC-BR-051"
```

For the original suite, drop `-c ...` and use `--project=e2e-execute` /
`--project=e2e-validate`.

### Where results land

| What | Original suite | BRv4 |
|---|---|---|
| Run records + extracted ZIPs | `artifacts/e2e/runs/` | `artifacts/e2e-brv4/runs/` |
| Verdict per case | `artifacts/e2e/verdicts/` | `artifacts/e2e-brv4/verdicts/` |
| HTML report | `playwright-report/` | `playwright-report-brv4/` |
| Failure traces / screenshots | `test-results/` (`npx playwright show-trace <zip>`) | same |

### Gotchas

- **Original suite:** before re-executing against an environment that has
  already seen the feeds, reissue a fresh generation
  (`npm run reissue -- <n>`, needs Python — see *How to reissue test data*).
- **BRv4:** identifiers are permanent (generation 99). Setup and positive
  feeds can be committed only once.
- **BRv4 feed date:** the execute spec uses a single `BRV4_FEED_DATE`
  (default `20260908`) for every file. Verify this against the `DAY2` /
  `DAY3` feeds (`D20260909` / `D20260910`) if their runs look wrong.
- **BRv4 report script:** `scripts/regen-final-report-brv4.js` loads `xlsx`
  from `%TEMP%\xlsxreader\node_modules` and fails if that folder does not
  exist.

## What it covers

Read from the current `data/test-cases.json` / `data/feeds.json` — the actual
registry this project runs from, not the older counts quoted in the
reference package's own README (see *Documentation drift* below):

| | |
|---|---:|
| Test cases in the registry | 284 |
| Feed files to upload | 85 |
| Cases whose condition the feed actually forces (`executable`) | 226 |
| Cases blocked — condition not drivable from a feed | 58 |
| Confidence C cases (`bcr`) — observed, never Pass/Fail | 1 |

Only the 226 executable cases can return `PASS` or `FAIL`. The rest are
recorded `BLOCKED` with the reason from the registry (never deleted, never
converted to a verdict) — see *Blocked-test handling*.

## Prerequisites

- Node.js 18+ and npm
- Network access to the target environment (dev host has a self-signed-style
  certificate — see *HTTPS* below)
- Python 3 + `openpyxl`, **only** if you intend to rebuild the registry from
  the workbook or reissue a fresh generation (see *How to reissue test
  data*). Not required to run the test suite itself.

## Installation

```bash
npm install
npx playwright install chromium
```

## Environment configuration

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|---|---|---|
| `BASE_URL` | `https://pru-adb-dev.ap-southeast-1.elasticbeanstalk.com` | HR Master Console host |
| `ADB_USERNAME` | `admin` | Console login |
| `ADB_PASSWORD` | `admin` | Console login |
| `FEED_DATE` | `20260908` | Must match the date baked into the feed files' submitting headers |

Not named `USERNAME`/`PASSWORD` on purpose — Windows sets `USERNAME` itself,
to the logged-in OS account name, and a plain `process.env.USERNAME` would
silently pick that up instead of `.env`'s value. See `fixtures/console.fixture.ts`
and *Execution status* below for how this was actually found.

`.env` is gitignored. Never commit real credentials — the defaults above are
the dev console's own documented placeholder, not a secret.

### HTTPS

`playwright.config.ts` sets `ignoreHTTPSErrors: true`. The Elastic Beanstalk
dev host serves a certificate that does not chain to a trusted authority;
without this the browser refuses to navigate at all
(`ERR_CERT_AUTHORITY_INVALID`). This is preserved from the reference
implementation deliberately — it is a property of the *environment*, not a
convenience to relax elsewhere.

## Project structure

```
PRU-ADB-Playwright/
├── pages/
│   ├── LoginPage.ts          # login only
│   └── ConsolePage.ts        # upload tab, feed date, file select, submit,
│                              # run polling, run lookup, ZIP download
├── fixtures/
│   └── console.fixture.ts    # credentials from env; loginPage/consolePage/
│                              # authenticatedConsole fixtures
├── utils/
│   ├── types.ts              # TestCase / Feed / Generation interfaces
│   ├── registry.ts           # typed loaders for data/*.json
│   ├── artifact-validator.ts # ZIP extraction, LNA/CNTLRPT/skip-report parsing
│   ├── cp037.ts               # EBCDIC (IBM037) decode table for LOADFILE
│   ├── verdict-store.ts      # per-case verdict + per-feed run persistence
│   └── verdict-rules.ts      # the judging logic itself (no Playwright
│                              # dependency) — kept out of the spec files so
│                              # a test reads as a scenario, not an algorithm
├── tests/
│   ├── smoke/                # small, representative checks — see below
│   ├── e2e/                  # execution: upload every feed, record the run
│   └── validation/           # judge every case against the recorded runs;
│                              # touches the application not at all
├── scripts/                  # Python registry/feed-generation scripts,
│                              # carried over from the reference project
│   └── generate-report.ts    # traceability report from the verdicts on disk
├── data/
│   ├── test-cases.json       # 284 cases — the registry, definition of record
│   ├── feeds.json            # 85 feed files, in upload order
│   ├── generation.json       # which generation the feed files carry
│   └── feeds/                # the feed files themselves
├── reference-docs/           # source workbook + QA test plan (see below)
├── artifacts/                # generated at runtime — gitignored
│   ├── results.json
│   └── e2e/
│       ├── runs/<feed>.json          # one record per feed uploaded
│       ├── runs/run-<id>/            # the ZIP and its extracted contents
│       ├── console/<feed>.log        # Live console lines captured per feed
│       ├── verdicts/<case>.json      # one file per verdict
│       └── reports/                  # traceability-report.csv, summary.md
├── playwright.config.ts
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```

`reference-docs/` carries the three small source documents build_registry.py
reads (`PRU_ADB_E2E_Test_Scenarios_v4.xlsx`, the Blocked Rules Analysis
workbook, the QA Test Plan) plus the BRD reference workbooks — a few hundred
KB total. The much larger `Evidence/` folder from the reference package
(console logs, run records and verdicts from a prior execution — 2 MB, ~450
files) was **not** copied wholesale, per the instruction to keep the project
manageable; a handful of representative files were read during analysis
instead. If you need the full evidence trail, it is in the original
`PRU ADB Files.zip`.

## How the suite is organized

### Execution vs. validation

These are two separate Playwright projects on purpose, matching the
reference architecture: execution touches the application (uploads, waits,
downloads); validation only reads what execution already wrote to
`artifacts/e2e/runs/`. Re-running validation costs nothing and consumes no
identifiers — re-running execution does (see *No data reset*).

### Smoke tests (`tests/smoke/`)

Small, representative checks meant to validate the framework itself before
running the full suite, per the recommended execution strategy:

- `verdict-logic.spec.ts` — unit tests against `utils/verdict-rules.ts` with
  synthetic data. No network, no upload; safe and fast. Covers the masking
  rule for negative cases, the positive-case load-file check, and the
  destination-based judging for both forced and non-forced conditions.
- `login.spec.ts` — logs into the live console and confirms the Upload tab
  loads. Uploads nothing.
- `single-feed-negative.spec.ts` — runs the full pipeline (login → set date →
  upload → wait → download → extract → validate → verdict) for one
  representative case, `TC-BR-018` / `ALLSTATE.LNA.B0607.D20260908.txt`. This
  feed is deliberately chosen because its bundle is rejected before commit
  (0 committed, 2 rolled back in the historical evidence) — re-running it
  never presents an identifier ADB has already committed, so it is safe to
  run against any generation, unlike a positive case.

```bash
npm run test:smoke
```

### Full suite

```bash
# 1. Issue a fresh generation before an execution against an environment
#    that has already seen these feeds — see "No data reset" and
#    "How to reissue test data".
npm run reissue -- 7

# 2. Upload every feed file in data/feeds.json and download its artifacts.
npm run e2e:execute

# 3. Judge every test case against what came back. Touches nothing; re-runnable.
npm run e2e:validate

# 4. Build the traceability report from the verdicts on disk.
npm run report:build
```

`npm run e2e:execute:plan` lists what step 2 would upload, without uploading
anything.

To run one feed file only:

```bash
npx playwright test --project=e2e-execute --grep "B0607"
```

## How to run a specific TCID

Validation is one test per case, titled `<TCID>  <rule>  <expected code or
destination>`:

```bash
npx playwright test --project=e2e-validate --grep "TC-BR-018"
```

This only works after `e2e:execute` has produced a run record for that case's
feed file.

## How to generate the report

```bash
npm run report:build
```

Reads every verdict file under `artifacts/e2e/verdicts/` and writes:

- `artifacts/e2e/reports/traceability-report.csv` — one row per case: TCID,
  BR ID, Type, Feed, Expected Result, Actual Result, Destination Artifact,
  Status, Reason.
- `artifacts/e2e/reports/summary.md` — status counts, blocked cases grouped
  by reason, and every `FAIL` with its notes.

Playwright's own HTML report (`npm run report`) and `artifacts/results.json`
are also produced by every run, per the `playwright.config.ts` reporters.

## How to reissue test data

The environment has no data reset. A bundle whose firm record passes
validation commits its organisation, and presenting the same identifiers
again raises **B0700** instead of the condition under test.

```bash
npm run reissue -- 7
```

rebuilds every feed file in `data/feeds.json` with generation-7 identifiers —
every bundle in the whole set gets an identifier no other bundle has, in this
run or any previous one — then refreshes the record indexes and the
test-case registry, and stamps `data/generation.json`.

Run it immediately before an execution. Never during one. The execution
project refuses to start without `data/generation.json`.

**Limitation carried over from the reference package:** `reissue_e2e.py`
orchestrates four feed-content generators (`make_feeds.py`,
`make_feeds_dest.py`, `make_feeds_t1.py`, `make_feeds_state.py`). Those four
still reference a few source inputs — a merged demo feed file, a
`PRU_ADB_E2E_Test_Data_v4` spec folder, and a dated copy of the BRD workbook —
that live on the original author's machine and were not part of the
delivered `PRU ADB Files.zip`. `scripts/_paths.py` makes the *orchestration*
(`reissue_e2e.py`) and the *registry build* (`build_registry.py`) portable —
both now resolve `data/feeds/` and the workbook under `reference-docs/`
relative to the project, overridable with `PRU_ADB_FEED_DIR` /
`PRU_ADB_WORKBOOK` — but the four content generators were left as-is rather
than risk silently changing feed-generation logic with no Python interpreter
available in this session to verify the edits against. If you have access to
those source materials, point `PRU_ADB_ROOT` at them (see each script's
docstring) and `reissue_e2e.py` will work end to end; otherwise, `data/feeds/`
already contains 85 generation-13 feed files, sufficient to run the suite
once (see *No data reset* for what "once" means in practice).

Python 3 was not available in the environment this project was built in, so
none of this was executed or verified this session — it is carried forward
from a working reference implementation, with the path changes above applied
by inspection.

## Verdict rules

Applied in this order, from `utils/verdict-rules.ts` and
`tests/validation/validate-cases.spec.ts`:

1. **A Confidence C rule (`bcr: true`) is `OBSERVED`.** The registry says the
   BRD source contradicts itself, so no expected result can be stated.
   Behaviour is recorded, never passed or failed. QA Test Plan v1.00 §6.3.
2. **A case whose condition the feed does not force (`executable: false`) is
   `BLOCKED`.** Not `FAIL`. The registry's `blockedReason` is carried into
   the verdict verbatim.
3. **An automation or environment failure is `BLOCKED`.** Not `FAIL`. If the
   upload throws, the run record carries the error and every case on that
   feed is blocked with it quoted.

Otherwise:

- **Negative case** (`destinationArtifact === 'LNAERROR'`, an `expectedCode`
  is named, and `conditionForced` is true) — the expected code must appear in
  the LNA report against one of the bundle's record positions
  (`judgeNegative`). A different code firing first is `FAIL`, noted as
  possibly masking the rule under test.
- **Positive case** (`type === 'Positive'`) — no refusal against the bundle,
  *and* its broker-dealer identifier present in the LOADFILE
  (`judgePositive`). Absence of a refusal alone is not enough: a bundle can
  be neither refused nor applied, and that is a finding.
- **Header-control case** (`destinationArtifact === 'CNTLRPT'`, no
  `expectedCode`, condition forced) — either the header is refused and the
  run stops (`judgeHeaderControl`), or the controls are reported satisfied
  and the run proceeds (`judgeControlsSatisfied`), decided by whether the
  bundle's own class is `positive`.
- **Everything else** — `judgeDestination`: did the output land at the
  destination the BRD assigns? When the feed does not force the condition,
  the record is valid and belongs in the successful output instead; landing
  there is the pass, not a failure.

An automation problem is never written up as an application defect, and a
`FAIL` is never promoted to `PASS`.

## Blocked-test handling

Blocked cases are never deleted, never silently skipped without a reason, and
never converted to `PASS`. `tests/validation/validate-cases.spec.ts` writes a
`BLOCKED` verdict (with the registry's `blockedReason`) for every
non-executable case *before* calling `test.skip()`, so the reason is on disk
regardless of how the test itself reports:

```ts
recordVerdict({ ...base, verdict: 'BLOCKED', notes: tc.blockedReason });
test.skip(true, tc.blockedReason);
```

The 58 currently blocked, by reason (see `artifacts/e2e/reports/summary.md`
after a validation run for the live count):

| Reason | Cases |
|---|---:|
| Output is assigned to `errfile-<CCYYMMDD>.csv`; no downloaded artifact has ever contained one | 24 |
| No feed file exists for the case; a Java exception produces no downloadable artifact | 30 |
| No feed file exists; the outcome goes to the application log only | 1 |
| Destination is a Java exception, the log, or none at all — nothing is written to a file that can be read | 3 |

## What changed from the reference implementation

Two things were **not** ported as-is, both found while reading the reference
project rather than assumed to be correct — per the instruction not to treat
the existing automation as perfect:

### 1. Documentation drift in the reference `README-E2E.md`

The reference README states 68 feed files, 88 forceable cases and 196
blocked cases. The registry it ships (`automation/data/test-cases.json`,
`automation/data/feeds.json` — the same files this project's `data/` was
built from) actually contains **85 feed files** (1 setup + 57 error-code + 9
destination + 8 java-recovered + 1 positive + 9 state) and **226 executable
cases** (58 blocked). The registry was clearly rebuilt after the README was
written — `java-recovered` and `state` feed families do not appear in the
README's own layout section — and the README was never regenerated to
match. This project's counts above come from the registry (the actual
source of record), not the stale prose. If a future rebuild changes these
numbers again, the counts in `data/*.json` are what to trust.

### 2. `judgeNegative` was dead code in the reference test file

`automation/tests/e2e-02-validate.spec.ts` defines `judgeNegative` — the
function that implements the masking rule described in its own README ("a
different code firing first is FAIL, noted as possibly masking the rule
under test") — but the test loop's dispatch never calls it. Every case,
negative or otherwise, was judged by the more general `judgeDestination`,
which treats *any* refusal at the right destination as `PASS` regardless of
which code fired. `judgeSkip` (the equivalent for skip-report cases) is
similarly defined and unused.

This is not cosmetic: checking the historical evidence in the reference
package (`Evidence/verdicts/*.json`, a prior real execution) against the
stricter rule found **8 cases marked `PASS` by the reference implementation
where the code that actually fired did not match the expected code** —
`TC-BR-063`, `TC-BR-181`, `TC-BR-200`, `TC-BR-206`, `TC-BR-212`, `TC-BR-213`,
`TC-BR-235`, `TC-BR-236`. Under the documented rule (and under this
project's own instructions, which independently specify the same masking
behavior), these should have been `FAIL`, flagged for investigation of which
rule actually fired first — not silently passed.

`tests/validation/validate-cases.spec.ts` in this project wires
`judgeNegative` in for exactly the cases it was written for — destination
`LNAERROR`, an expected code named, **and** `conditionForced: true`. That
last condition matters: five other cases (`TC-BR-048`, `TC-BR-250` through
`TC-BR-253`) also name an expected code against `LNAERROR` but have
`conditionForced: false` — the feed does *not* force their condition, so
they are correctly judged as valid records that must be accepted, not as
negative cases expecting a refusal. Routing those through `judgeNegative`
too would have wrongly failed them. This distinction is exercised in
`tests/smoke/verdict-logic.spec.ts`.

The 8 reclassified cases have not been re-executed against the live
environment in this session (see *Execution status*) — they are flagged here
as cases to re-run and investigate, not asserted as confirmed application
defects. See `artifacts/e2e/verdicts/` after a fresh execution + validation
for the current, corrected verdicts.

## Distinguishing automation issues from application defects

- **Automation issue**: wrong locator, incorrect wait, bad artifact parsing,
  a dispatch bug like the one above. Fixed in the automation; the expected
  result is never changed to make a test pass.
- **Application defect**: the application rejects a valid file, produces the
  wrong code, misses an expected artifact, or routes output to the wrong
  destination. Recorded as a `FAIL` with full evidence (expected vs. actual,
  the run's console log, the artifact it landed in instead) — never silently
  fixed by changing what the test expects.

## Execution status

Verified this session, against the real project (not just reasoning about
the reference package):

- `npx tsc --noEmit` — clean, no errors.
- `npx playwright test --list` — all 381 tests discoverable (12 smoke, 85
  execute, 284 validate).
- `tests/smoke/verdict-logic.spec.ts` — all 10 unit tests pass. This is the
  judging logic itself (`utils/verdict-rules.ts`), exercised offline against
  synthetic data, including the negative-case masking rule and the
  `judgeNegative` fix described above.
- `tests/smoke/login.spec.ts` — **passed live**, against
  `https://pru-adb-dev.ap-southeast-1.elasticbeanstalk.com`, with `admin`/
  `admin`, run plainly as `npx playwright test --project=smoke` with no
  inline environment overrides. The login page states *"Session-based,
  single shared account — not per-user auth,"* confirming the serial /
  `workers: 1` execution strategy is required for a second reason beyond
  no-data-reset: two people (or two runs) logged in at once would share one
  session.
- `tests/smoke/single-feed-negative.spec.ts` — **passed live**. Real run
  (`runId f9efefd1-...`) against `ALLSTATE.LNA.B0607.D20260908.txt`: logged
  in, uploaded, waited for the run to settle, downloaded the General
  Artifacts ZIP, extracted it, parsed the real LNA report, and judged it.
  The live LNA report contains exactly what `TC-BR-018` expects:
  ```
  C00 - FIRM ENTITY ~...~A130001200~...~B0607~"BUSINESS ADDRESS" NOT VALUED OR INVALID IN THE FIRST "FIRM ENTITY" (BD) RECORD. BD FIRM BUNDLE REJECTED
  ```
  This exercises every stage of the pipeline against the real application:
  login, upload, run-polling, download, ZIP extraction, LNA parsing, and
  `judgeNegative` — end to end, not by inspection. Evidence retained under
  `artifacts/e2e/runs/run-f9efefd1-f34a-43bb-ac79-3bfa081acec0/`.
  Note: this smoke test asserts and reports through Playwright but does not
  call `recordVerdict` — it shares `utils/verdict-rules.ts` with the real
  suite but deliberately does not write into `artifacts/e2e/verdicts/`, so a
  smoke run cannot be mistaken for full-suite traceability data. The PASS
  is evidenced by the Playwright run above and the extracted artifact, not
  by a verdict JSON file.
- The full 85-feed suite and any positive-case live run were **not**
  attempted this session: the environment's last known generation (13)
  already has committed bundles from a prior real execution (in the
  reference package's `Evidence/` folder), and Python 3 was unavailable to
  reissue a fresh one, so re-uploading unreissued feeds would raise `B0700`
  on every case that commits rather than exercising the condition under
  test. The two smoke feeds above are both from families that never commit
  (setup/error-code, rolled back before commit), which is why they were safe
  to run against the already-used generation.

**A note on login flakiness earlier in this project's development**, kept
here because it is a real automation bug and worth understanding if
anything like it resurfaces: multiple live attempts were rejected with
*"Incorrect username or password"* against credentials that were later
confirmed correct, in a pattern that looked like it might be intermittent
environment flakiness or shared-account session contention. Neither was
true. Logging the exact strings reaching the login form showed the actual
username being submitted was the machine's Windows account name, not
`admin`. The cause: `fixtures/console.fixture.ts` originally read
`process.env.USERNAME`, and Windows itself always sets `USERNAME` to the
logged-in OS account — so a plain `.env` file entry of the same name never
took effect (it only overrides variables that aren't already set) unless
`USERNAME=admin` was also typed inline on the command line, which is why a
couple of early attempts happened to work. Fixed by renaming the project's
variables to `ADB_USERNAME`/`ADB_PASSWORD` (see *Environment configuration*
above) — collision-proof, and confirmed working with a plain
`npx playwright test --project=smoke` and no inline overrides. The lesson
generalizes: on Windows specifically, avoid `USERNAME`, `PASSWORD` (used by
some tools), `PATH`, `TEMP`/`TMP`, `COMPUTERNAME` and similar OS-reserved
names for project environment variables, and when a live check fails in a
way that doesn't make sense, log the exact value in flight before
theorizing about the environment.

**Next step:** run `npm run e2e:execute` for the full 85-feed suite against
generation 13 as-is (negative/error-code feeds will replay meaningfully;
anything that already committed will come back `BLOCKED` on `B0700` rather
than re-testing its condition) — or arrange a fresh generation first if a
clean run is preferred.

For reference, the last real execution recorded in the supplied evidence
(generation 13, 2026-09-16) produced: **220 PASS, 5 FAIL, 58 BLOCKED, 1
OBSERVED** out of 284 — under the reference implementation's judging, i.e.
*before* the `judgeNegative` fix above. The 5 FAILs it did catch
(`TC-BR-047`, `TC-BR-172`, `TC-BR-230`, `TC-BR-233`, `TC-BR-309` — all
destination-routing mismatches) are carried into this project's findings as
candidate defects to reconfirm on the next real run.
