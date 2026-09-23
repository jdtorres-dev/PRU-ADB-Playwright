import { test, expect } from '../../fixtures/console.fixture';

/**
 * Smoke test: the HR Master Console is reachable and the login flow works.
 * Uploads nothing, so it is safe to run at any time against any generation.
 */
test('logs in and reaches the Upload tab', async ({ authenticatedConsole, page }) => {
  await expect(page.locator('#uploadFeedDate')).toBeVisible();
  await expect(page.locator('#uploadFile')).toBeAttached();
  void authenticatedConsole; // fixture performs login + openUploadTab
});
