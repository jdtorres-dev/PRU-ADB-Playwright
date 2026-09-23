import * as fs from 'fs';
import * as path from 'path';
import { TestCase, Feed, Generation } from './types';

/**
 * Typed loaders for data/*.json - the test-case and feed registries.
 *
 * Use these programmatically rather than hand-copying case data into test
 * files: a test file that hardcodes an expected code drifts from the
 * registry the moment the workbook changes.
 */

const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

function read<T>(name: string): T {
  const p = path.join(DATA_DIR, name);
  if (!fs.existsSync(p)) {
    throw new Error(`data/${name} is missing. See README.md > "How to reissue test data".`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

export const loadTestCases = (): TestCase[] => read<TestCase[]>('test-cases.json');
export const loadFeeds = (): Feed[] => read<Feed[]>('feeds.json');

/**
 * The generation the feed files currently carry. Absent means the feeds were
 * built without a reissue, which is fine for a first run on a clean
 * environment and a problem on any run after that (see README.md > "No data
 * reset").
 */
export function loadGeneration(): Generation | null {
  const p = path.join(DATA_DIR, 'generation.json');
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Generation) : null;
}

/**
 * Resolves a feed's file on this machine.
 *
 * feed.path is recorded at registry-build time and is not trusted as a live
 * path - the registry may have been built on a different machine (it is
 * committed as history/provenance, not as a working path). The file is
 * always looked up by name under data/feeds/.
 */
export function feedAbsolutePath(feed: Feed): string {
  return path.join(DATA_DIR, 'feeds', feed.file);
}

/** Cases whose condition the feed file actually forces. Only these can return Pass or Fail. */
export const executableCases = (all: TestCase[]): TestCase[] => all.filter((c) => c.executable);

/** Cases that cannot return a verdict, with the reason. Recorded BLOCKED, never FAIL. */
export const blockedCases = (all: TestCase[]): TestCase[] => all.filter((c) => !c.executable);

/** Test cases whose records live in a given feed file. */
export function casesForFeed(all: TestCase[], feed: string): TestCase[] {
  return all.filter((c) => c.feeds.some((f) => f.feed === feed));
}
