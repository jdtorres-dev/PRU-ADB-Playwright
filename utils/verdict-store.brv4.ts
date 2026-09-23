import * as fs from 'fs';
import * as path from 'path';

// Isolated persistence for the BRv4-uncovered-rules suite. Same shape and
// pattern as utils/verdict-store.ts, but under artifacts/e2e-brv4/ so a run
// of this suite can never read, overwrite, or be confused with a run record
// or verdict belonging to the original 85-feed/284-case suite.

export type VerdictValueBrv4 = 'PASS' | 'FAIL' | 'BLOCKED';

export interface VerdictBrv4 {
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
  verificationRoute: string;
  automationEligibility: string;
  expectedBusinessOutcome: string;
  expectedDataEffect: string;
  actualSummary: string;
  checkResults: Array<{ description: string; passed: boolean; detail: string }>;
  verdict: VerdictValueBrv4;
  notes: string;
  dbVerificationRequired: boolean;
  dbVerificationNotes: string;
  decidedAt: string;
}

const ROOT = path.join(__dirname, '..', 'artifacts');
export const E2E_ROOT_BRV4 = path.join(ROOT, 'e2e-brv4');
export const VERDICT_DIR_BRV4 = path.join(E2E_ROOT_BRV4, 'verdicts');
export const RUN_DIR_BRV4 = path.join(E2E_ROOT_BRV4, 'runs');

export function recordVerdictBrv4(v: Omit<VerdictBrv4, 'decidedAt'>): VerdictBrv4 {
  const full: VerdictBrv4 = { ...v, decidedAt: new Date().toISOString() };
  fs.mkdirSync(VERDICT_DIR_BRV4, { recursive: true });
  fs.writeFileSync(path.join(VERDICT_DIR_BRV4, `${v.testCaseId}.json`), JSON.stringify(full, null, 2));
  return full;
}

export function readVerdictsBrv4(): VerdictBrv4[] {
  if (!fs.existsSync(VERDICT_DIR_BRV4)) return [];
  return fs
    .readdirSync(VERDICT_DIR_BRV4)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(VERDICT_DIR_BRV4, f), 'utf8')) as VerdictBrv4)
    .sort((a, b) => a.testCaseId.localeCompare(b.testCaseId));
}

export interface RunRecordBrv4 {
  feedFile: string;
  feedPath: string;
  feedDate: string;
  generation: number | null;
  runId: string;
  runStatus: string;
  zipPath: string;
  extractedDir: string;
  artifacts: Record<string, string>;
  logLines?: string[];
  outcome?: { committed: number; rolledBack: number; skipped: number; warnings: string[] };
  uploadedAt: string;
  error?: string;
}

export function recordRunBrv4(r: Omit<RunRecordBrv4, 'uploadedAt'>): void {
  fs.mkdirSync(RUN_DIR_BRV4, { recursive: true });
  const safe = r.feedFile.replace(/[^A-Za-z0-9._-]/g, '_');
  fs.writeFileSync(
    path.join(RUN_DIR_BRV4, `${safe}.json`),
    JSON.stringify({ ...r, uploadedAt: new Date().toISOString() }, null, 2),
  );
}

export function readRunBrv4(feedFile: string): RunRecordBrv4 | null {
  const safe = feedFile.replace(/[^A-Za-z0-9._-]/g, '_');
  const p = path.join(RUN_DIR_BRV4, `${safe}.json`);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as RunRecordBrv4) : null;
}

export function readRunsBrv4(): RunRecordBrv4[] {
  if (!fs.existsSync(RUN_DIR_BRV4)) return [];
  return fs
    .readdirSync(RUN_DIR_BRV4)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(RUN_DIR_BRV4, f), 'utf8')) as RunRecordBrv4);
}
