import * as fs from 'fs';
import * as path from 'path';

/**
 * Verdict persistence.
 *
 * Every verdict is written to its own file the moment it is decided. Playwright
 * restarts the worker after a failing test, which discards an in-memory
 * accumulator and silently loses everything recorded before it.
 */

export type VerdictValue = 'PASS' | 'FAIL' | 'BLOCKED' | 'OBSERVED';

export interface Verdict {
  testCaseId: string;
  rule: string;
  topic: string;
  priority: string;
  feedFile: string;
  feedDate: string;
  generation: number | null;
  runId: string;
  runStatus: string;
  artifactZip: string;
  recordPositions: string;
  expectedCode: string;
  expectedDescription: string;
  expectedDestination: string;
  actualCode: string;
  actualDescription: string;
  actualDestination: string;
  verdict: VerdictValue;
  notes: string;
  decidedAt: string;
}

const ROOT = path.join(__dirname, '..', 'artifacts');
export const E2E_ROOT = path.join(ROOT, 'e2e');
export const VERDICT_DIR = path.join(E2E_ROOT, 'verdicts');
export const RUN_DIR = path.join(E2E_ROOT, 'runs');

export function recordVerdict(v: Omit<Verdict, 'decidedAt'>): Verdict {
  const full: Verdict = { ...v, decidedAt: new Date().toISOString() };
  fs.mkdirSync(VERDICT_DIR, { recursive: true });
  fs.writeFileSync(path.join(VERDICT_DIR, `${v.testCaseId}.json`), JSON.stringify(full, null, 2));
  return full;
}

export function readVerdicts(): Verdict[] {
  if (!fs.existsSync(VERDICT_DIR)) return [];
  return fs
    .readdirSync(VERDICT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(VERDICT_DIR, f), 'utf8')) as Verdict)
    .sort((a, b) => a.testCaseId.localeCompare(b.testCaseId));
}

export interface RunRecord {
  feedFile: string;
  feedPath: string;
  feedDate: string;
  generation: number | null;
  runId: string;
  runStatus: string;
  zipPath: string;
  extractedDir: string;
  artifacts: Record<string, string>;
  /** Lines captured from the Live console while the run was in progress. */
  logLines?: string[];
  /** What the console says became of the file. */
  outcome?: { committed: number; rolledBack: number; skipped: number; warnings: string[] };
  uploadedAt: string;
  error?: string;
}

/**
 * Reads the Live console summary.
 *
 *   "HR1 feed ingestion complete: 1 bundle(s) committed, 0 rolled back, 0 record(s) skipped"
 *
 * This is the only direct statement of what happened to an uploaded file, and it
 * says which destination the records should be looked for in.
 */
export function summariseLogs(lines: string[]): {
  committed: number; rolledBack: number; skipped: number; warnings: string[];
} {
  let committed = 0, rolledBack = 0, skipped = 0;
  const warnings: string[] = [];
  for (const line of lines) {
    const m = line.match(
      /(\d+)\s+bundle\(s\)\s+committed,\s*(\d+)\s+rolled back(?:,\s*(\d+)\s+record\(s\)\s+skipped)?/i,
    );
    if (m) {
      committed = Math.max(committed, Number(m[1]));
      rolledBack = Math.max(rolledBack, Number(m[2]));
      if (m[3] !== undefined) skipped = Math.max(skipped, Number(m[3]));
    }
    if (/\bWARN\b|\bERROR\b/i.test(line)) warnings.push(line.trim());
  }
  return { committed, rolledBack, skipped, warnings };
}

/** One record per feed file uploaded. This is what ties a verdict back to its run. */
export function recordRun(r: Omit<RunRecord, 'uploadedAt'>): void {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const safe = r.feedFile.replace(/[^A-Za-z0-9._-]/g, '_');
  fs.writeFileSync(
    path.join(RUN_DIR, `${safe}.json`),
    JSON.stringify({ ...r, uploadedAt: new Date().toISOString() }, null, 2),
  );
}

export function readRun(feedFile: string): RunRecord | null {
  const safe = feedFile.replace(/[^A-Za-z0-9._-]/g, '_');
  const p = path.join(RUN_DIR, `${safe}.json`);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as RunRecord) : null;
}

export function readRuns(): RunRecord[] {
  if (!fs.existsSync(RUN_DIR)) return [];
  return fs
    .readdirSync(RUN_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(RUN_DIR, f), 'utf8')) as RunRecord);
}
