import { defineConfig } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// Minimal .env loader - no extra dependency needed for three variables.
// Values already present in process.env (e.g. set by CI) are not overridden.
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
 * PRU ADB HR Master Console - Playwright configuration.
 *
 * ignoreHTTPSErrors is required: the Elastic Beanstalk dev host serves a
 * certificate that does not chain to a trusted authority. Without it the
 * browser refuses to navigate at all (ERR_CERT_AUTHORITY_INVALID).
 *
 * fullyParallel / workers=1 / retries=0 are deliberate, not defaults left in
 * place: the environment has no data reset. A bundle that commits does so
 * permanently, so two runs (or a retry of one) can present the same
 * identifiers twice and raise B0700 instead of exercising the rule under
 * test. Concurrency and retries are both disabled for every project here,
 * including the validation project, which is safe to parallelise on its own
 * merits but is kept serial so the config carries one rule, not an exception
 * per project.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 10 * 60 * 1000, // a single feed's run can take up to a few minutes to settle
  expect: { timeout: 30 * 1000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'artifacts/results.json' }],
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
  projects: [
    // Small, representative checks: login, one negative-case upload/validate,
    // one positive-case upload/validate. Safe to run repeatedly while the
    // framework is being developed - see tests/smoke/README.md.
    {
      name: 'smoke',
      testMatch: ['smoke/**/*.spec.ts'],
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, acceptDownloads: true },
    },
    // Full BRD v4 suite - uploads every feed file in data/feeds.json.
    // Must be preceded by a fresh generation: npm run reissue -- <n>
    {
      name: 'e2e-execute',
      testMatch: ['e2e/**/*.spec.ts'],
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, acceptDownloads: true },
    },
    // Judges the artifacts e2e-execute already downloaded. Touches the
    // application not at all - safe to re-run as often as needed.
    {
      name: 'e2e-validate',
      testMatch: ['validation/**/*.spec.ts'],
      use: { browserName: 'chromium' },
    },
  ],
});
