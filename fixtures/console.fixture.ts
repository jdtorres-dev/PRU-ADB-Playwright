import { test as base } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { ConsolePage } from '../pages/ConsolePage';

export interface Credentials {
  username: string;
  password: string;
}

/**
 * Reads ADB_USERNAME/ADB_PASSWORD from the environment (see .env.example).
 * Falls back to the dev console's documented default so the framework keeps
 * working out of the box against the dev environment - never use this
 * fallback against anything other than a disposable dev instance.
 *
 * Deliberately NOT named USERNAME/PASSWORD: Windows sets USERNAME itself, to
 * the logged-in OS account name. A plain process.env.USERNAME || 'admin'
 * silently picked up the Windows username instead of .env's value whenever
 * the shell already had USERNAME set (i.e. always, on Windows, unless
 * overridden inline on the command line) - the login form then submitted
 * the OS username with password "admin" and was correctly rejected. Found
 * by logging the exact strings reaching the form; not a credentials or
 * session problem, an env-var name collision.
 */
function credentialsFromEnv(): Credentials {
  return {
    username: process.env.ADB_USERNAME || 'admin',
    password: process.env.ADB_PASSWORD || 'admin',
  };
}

interface ConsoleFixtures {
  credentials: Credentials;
  loginPage: LoginPage;
  consolePage: ConsolePage;
  /** consolePage, already authenticated and on the Upload tab. */
  authenticatedConsole: ConsolePage;
}

export const test = base.extend<ConsoleFixtures>({
  // eslint-disable-next-line no-empty-pattern
  credentials: async ({}, use) => {
    await use(credentialsFromEnv());
  },
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  consolePage: async ({ page }, use) => {
    await use(new ConsolePage(page));
  },
  authenticatedConsole: async ({ loginPage, consolePage, credentials }, use) => {
    await loginPage.login(credentials.username, credentials.password);
    await consolePage.openUploadTab();
    await use(consolePage);
  },
});

export { expect } from '@playwright/test';
