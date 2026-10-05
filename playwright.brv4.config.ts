import { defineConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// Minimal .env loader, identical to playwright.config.ts's own (kept as a
// separate copy so this file has zero import-time dependency on the
// original config).
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv(path.join(__dirname, '.env'));

/**
 * PRU ADB HR Master Console - isolated Playwright configuration for the
 * BRv4-uncovered-rules suite (see data/test-cases.brv4.json).
 *
 * A separate config file, not new projects bolted onto playwright.config.ts,
 * so the original suite's own `testMatch: ['e2e/**\/*.spec.ts']` /
 * `['validation/**\/*.spec.ts']` globs can never pick up these new spec
 * files (they live under tests/e2e-brv4/ and tests/validation-brv4/, outside
 * both globs) and neither config can ever run the other's tests.
 *
 * Same fullyParallel:false / workers:1 / retries:0 rule as the original,
 * same reason: the environment has no data reset.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 10 * 60 * 1000,
  expect: { timeout: 30 * 1000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report-brv4', open: 'never' }],
    ['json', { outputFile: 'artifacts/results-brv4.json' }],
  ],
  use: {
    baseURL: process.env.BASE_URL || 'https://pru-adb-dev.ap-southeast-1.elasticbeanstalk.com',
    ignoreHTTPSErrors: true,
    actionTimeout: 30 * 1000,
    navigationTimeout: 60 * 1000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  // Listed in run order. With workers: 1, Playwright runs projects in the
  // order they appear here, so a single "run all" (CLI or the UI's top-level
  // run button) goes: upload feeds -> validate them -> DB-verified cases.
  // Validation must come before the DB-verified cases so they write last.
  // No `dependencies` on purpose: those would re-run the upload project
  // whenever a single later test is run, re-presenting committed identities.
  projects: [
    {
      name: 'e2e-execute-brv4',
      testMatch: ['e2e-brv4/execute-feeds.brv4.spec.ts'],
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, acceptDownloads: true },
    },
    {
      name: 'e2e-validate-brv4',
      testMatch: ['validation-brv4/**/*.spec.ts'],
      use: { browserName: 'chromium' },
    },
    {
      name: 'e2e-db-brv4',
      testMatch: ['e2e-brv4/db-verified-cases.brv4.spec.ts'],
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, acceptDownloads: true },
    },
    // One-off maintenance specs (direct DB writes, e.g.
    // _cleanup-stuck-queue.spec.ts) never run as part of a normal run - only
    // when explicitly enabled with BRV4_MAINTENANCE=1.
    ...(process.env.BRV4_MAINTENANCE === '1'
      ? [{
          name: 'maintenance-brv4',
          testMatch: ['e2e-brv4/_*.spec.ts'],
          use: { browserName: 'chromium' as const, viewport: { width: 1440, height: 900 }, acceptDownloads: true },
        }]
      : []),
  ],
});
