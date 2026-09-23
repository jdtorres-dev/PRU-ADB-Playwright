import * as fs from 'fs';
import * as path from 'path';
import type { TestCaseBrv4, FeedBrv4, GenerationBrv4 } from './types.brv4';

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

export function loadTestCasesBrv4(): TestCaseBrv4[] {
  const p = path.join(DATA_DIR, 'test-cases.brv4.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as TestCaseBrv4[];
}

export function loadFeedsBrv4(): FeedBrv4[] {
  const p = path.join(DATA_DIR, 'feeds.brv4.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as FeedBrv4[];
}

export function loadGenerationBrv4(): GenerationBrv4 | null {
  const p = path.join(DATA_DIR, 'generation.brv4.json');
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as GenerationBrv4) : null;
}

// Always resolves under data/feeds/ by filename - same directory the original
// 85-feed suite uses, per the project's own convention (new files, not new
// directories, for test data).
export function feedAbsolutePathBrv4(feed: FeedBrv4): string {
  return path.join(DATA_DIR, 'feeds', feed.file);
}

export function executableCasesBrv4(all: TestCaseBrv4[]): TestCaseBrv4[] {
  return all.filter((c) => c.executable);
}

export function blockedCasesBrv4(all: TestCaseBrv4[]): TestCaseBrv4[] {
  return all.filter((c) => !c.executable);
}

export function casesForFeedBrv4(all: TestCaseBrv4[], feedFile: string): TestCaseBrv4[] {
  return all.filter((c) => c.feeds.some((f) => f.feed === feedFile));
}
