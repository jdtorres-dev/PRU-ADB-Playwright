import { Page, Locator, expect } from '@playwright/test';

/**
 * Login page object for the PRU ADB HR Master Console.
 *
 * The dashboard route (/ingestion-dashboard.html) redirects an unauthenticated
 * request to the login page, so login is a precondition of navigating there
 * rather than a separate URL a test visits directly - see login().
 */
export class LoginPage {
  private readonly username: Locator;
  private readonly password: Locator;
  private readonly submit: Locator;

  constructor(private readonly page: Page) {
    this.username = page.locator('#username');
    this.password = page.locator('#password');
    this.submit = page.locator('form[action="/login"] button[type="submit"]');
  }

  /**
   * Navigates to the dashboard and logs in if redirected to the login page.
   * A session already authenticated (cookie still valid) is a no-op past the
   * navigation - this is what makes login() safe to call at the top of every
   * test rather than only once per suite.
   *
   * Retries the credentialed submit itself (not the whole test) up to
   * MAX_ATTEMPTS times, for ordinary environment flakiness (a slow first
   * request, a dropped response). Retrying login specifically carries none
   * of the identifier-reuse risk retries:0 protects against elsewhere,
   * because no feed file has been presented yet at this point.
   *
   * Note: what initially looked like intermittent rejection of correct
   * credentials here was not the environment being flaky - it was
   * fixtures/console.fixture.ts reading process.env.USERNAME, which Windows
   * sets to the OS account name regardless of .env. See that file's comment.
   * This retry loop is kept for genuine network flakiness, not because it
   * was the fix for that.
   */
  async login(username: string, password: string): Promise<void> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.page.goto('/ingestion-dashboard.html', { waitUntil: 'domcontentloaded' });
      if (!this.page.url().includes('login')) break; // already authenticated

      await this.username.fill(username);
      await this.password.fill(password);
      await this.submit.click();

      try {
        await this.page.waitForURL(/ingestion-dashboard/, { timeout: 20_000 });
        break; // succeeded
      } catch (e) {
        if (attempt === MAX_ATTEMPTS) throw e;
        // eslint-disable-next-line no-console
        console.log(`login attempt ${attempt} failed (${this.page.url()}), retrying...`);
      }
    }

    await expect(this.page.locator('#uploadFile')).toBeAttached({ timeout: 30_000 });
  }
}
