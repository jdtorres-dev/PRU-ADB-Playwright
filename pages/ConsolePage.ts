import { Page, Locator, expect, Download } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Page object for the HR Master Console's ingestion dashboard - the upload,
 * run-status and General Artifacts panels. Login is a separate page object
 * (pages/LoginPage.ts): this one assumes an authenticated session.
 *
 * Selectors were taken from the live dashboard markup, not guessed:
 *   #tabBtnUpload                                    "Upload a feed file" tab
 *   #uploadFeedDate                                  feed date (type=date)
 *   #uploadFile                                      file input (accepts .dat,.txt,.csv)
 *   #uploadBtn                                       submit
 *   #runIdInput / #lookupBtn                         load a run into the console view
 *   #downloadAllBtn                                  General Artifacts -> ALL (.zip)
 */
export class ConsolePage {
  private static readonly RUN_API = '/api/v1/ingestion/runs';

  private readonly uploadTab: Locator;
  private readonly feedDateInput: Locator;
  private readonly fileInput: Locator;
  private readonly uploadButton: Locator;
  private readonly restartCheckbox: Locator;
  private readonly runIdInput: Locator;
  private readonly lookupButton: Locator;
  private readonly downloadAllButton: Locator;

  constructor(private readonly page: Page) {
    this.uploadTab = page.locator('#tabBtnUpload');
    this.feedDateInput = page.locator('#uploadFeedDate');
    this.fileInput = page.locator('#uploadFile');
    this.uploadButton = page.locator('#uploadBtn');
    this.restartCheckbox = page.locator('#uploadRestart');
    this.runIdInput = page.locator('#runIdInput');
    this.lookupButton = page.locator('#lookupBtn');
    this.downloadAllButton = page.locator('#downloadAllBtn');
  }

  /**
   * Lines collected from the Live console during the most recent wait.
   *
   * The console is the only place that says what actually became of an
   * uploaded file - how many bundles committed, how many rolled back, how
   * many records were skipped. The /logs endpoint serves them only while the
   * run is live; once it has settled the buffer is gone (a completed run
   * returns 404), so they have to be collected as the run proceeds, exactly
   * as the dashboard does.
   */
  private collectedLogs: string[] = [];

  getCollectedLogs(): string[] {
    return this.collectedLogs;
  }

  async openUploadTab(): Promise<void> {
    await expect(this.uploadTab).toBeVisible();
    if ((await this.uploadTab.getAttribute('aria-selected')) !== 'true') {
      await this.uploadTab.click();
    }
    await expect(this.feedDateInput).toBeVisible();
  }

  /** feedDate must be CCYYMMDD, as carried in the feed file's submitting header. */
  async setFeedDate(feedDateCcyymmdd: string): Promise<void> {
    const iso = `${feedDateCcyymmdd.slice(0, 4)}-${feedDateCcyymmdd.slice(4, 6)}-${feedDateCcyymmdd.slice(6, 8)}`;
    await this.feedDateInput.fill(iso);
    await expect(this.feedDateInput).toHaveValue(iso);
  }

  async chooseFile(absolutePath: string): Promise<void> {
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Feed file not found: ${absolutePath}`);
    }
    await this.fileInput.setInputFiles(absolutePath);
  }

  /** The upload form's own "restart" checkbox - independent of file/date selection. */
  async setRestart(checked: boolean): Promise<void> {
    if (checked) await this.restartCheckbox.check();
    else await this.restartCheckbox.uncheck();
  }

  /**
   * Submits the upload and returns the run id the application assigns.
   * The run id is read from the API response rather than scraped from the
   * banner, so it is the value the server actually issued.
   */
  async submitAndGetRunId(): Promise<string> {
    const responsePromise = this.page.waitForResponse(
      (r) => r.url().includes(`${ConsolePage.RUN_API}/uploads`) && r.request().method() === 'POST',
      { timeout: 120_000 },
    );
    await this.uploadButton.click();
    const response = await responsePromise;

    if (!response.ok()) {
      const text = await response.text().catch(() => '');
      throw new Error(`Upload rejected: HTTP ${response.status()} ${text.slice(0, 400)}`);
    }
    const body = (await response.json()) as { runId?: string };
    if (!body.runId) throw new Error(`Upload succeeded but no runId was returned: ${JSON.stringify(body)}`);
    return body.runId;
  }

  /**
   * Polls the run until it leaves ACCEPTED/IN_PROGRESS.
   * Returns the terminal run payload. Does not assert on the status: a run
   * that FAILED is still a run whose artifacts must be read before a verdict
   * is set.
   */
  async waitForRunToSettle(runId: string, timeoutMs = 240_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    let last: any = null;
    this.collectedLogs = [];
    let since = 0;

    const drainLogs = async () => {
      try {
        const body = await this.page.evaluate(
          async ([id, from]) => {
            const res = await fetch(
              `/api/v1/ingestion/runs/${encodeURIComponent(id as string)}/logs?since=${from}`,
              { headers: { Accept: 'application/json' } },
            );
            if (!res.ok) return null;
            return res.json();
          },
          [runId, since] as const,
        );
        // Each line is {timestamp, level, message} - not a string. Rendered
        // the way the dashboard renders it, so a saved log reads like the
        // Live console itself.
        if (body?.lines?.length) {
          for (const line of body.lines as Array<Record<string, unknown>>) {
            if (typeof line === 'string') {
              this.collectedLogs.push(line);
              continue;
            }
            const ts = line.timestamp ? String(line.timestamp) : '';
            const level = String(line.level ?? 'INFO').toUpperCase();
            const msg = String(line.message ?? '');
            this.collectedLogs.push(`${ts} ${level} ${msg}`.trim());
          }
        }
        if (typeof body?.nextSince === 'number') since = body.nextSince;
      } catch {
        // Best effort, as on the dashboard: the console enriches the record,
        // it is not the source of truth for whether the run finished.
      }
    };

    while (Date.now() < deadline) {
      await drainLogs();
      last = await this.page.evaluate(async (id) => {
        const res = await fetch(`/api/v1/ingestion/runs/${encodeURIComponent(id)}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return { status: `HTTP_${res.status}` };
        return res.json();
      }, runId);

      const status = String(last?.status ?? 'UNKNOWN').toUpperCase();
      if (status !== 'ACCEPTED' && status !== 'IN_PROGRESS' && status !== 'RUNNING') {
        await drainLogs(); // one last pass for the closing lines
        return last;
      }
      await this.page.waitForTimeout(1500);
    }
    throw new Error(`Run ${runId} did not settle within ${timeoutMs}ms (last status ${last?.status})`);
  }

  /**
   * One-shot status lookup by run id, independent of waitForRunToSettle's
   * polling loop (which only returns the terminal payload). Same endpoint,
   * used to observe an in-progress run's own answerable state.
   */
  async getRunStatus(runId: string): Promise<any> {
    return this.page.evaluate(async (id) => {
      const res = await fetch(`/api/v1/ingestion/runs/${encodeURIComponent(id)}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return { status: `HTTP_${res.status}` };
      return res.json();
    }, runId);
  }

  /** Loads the run into the console view so the artifacts panel is populated. */
  async openRun(runId: string): Promise<void> {
    await this.runIdInput.fill(runId);
    await this.lookupButton.click();
    await expect(this.downloadAllButton).toBeVisible({ timeout: 60_000 });
  }

  /** Clicks General Artifacts -> ALL (.zip) and saves it. Returns the saved path. */
  async downloadAllArtifacts(saveAsAbsolutePath: string): Promise<string> {
    const downloadPromise = this.page.waitForEvent('download', { timeout: 120_000 });
    await this.downloadAllButton.click();
    const download: Download = await downloadPromise;
    fs.mkdirSync(path.dirname(saveAsAbsolutePath), { recursive: true });
    await download.saveAs(saveAsAbsolutePath);
    return saveAsAbsolutePath;
  }
}
