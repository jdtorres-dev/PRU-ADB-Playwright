import { test } from '../../fixtures/console.fixture';
import { withDb } from '../../utils/db.brv4';

// One-off cleanup: marks the deliberately-bogus activity_log_entry probe row
// (pru_contract_or_org_code='ZZZZZ') as processed - not deleted, so it stays
// as evidence - since it appears to have stuck the HR2 sync batch job. Then
// confirms the queue is moving again.
test('cleanup: mark ZZZZZ poison-pill row processed and verify queue unsticks', async ({ authenticatedConsole }) => {
  const before = await withDb(async (client) => {
    const mc = await client.query('SELECT last_updated_date FROM adsi_master.master_control');
    const unprocessed = await client.query('SELECT count(*)::int AS n FROM pru_adb.activity_log_entry WHERE processed_ts IS NULL');
    const marked = await client.query("UPDATE pru_adb.activity_log_entry SET processed_ts = now() WHERE pru_contract_or_org_code = 'ZZZZZ' AND processed_ts IS NULL RETURNING *");
    return { mc: mc.rows[0], unprocessedBefore: unprocessed.rows[0].n, markedRows: marked.rows };
  });
  // eslint-disable-next-line no-console
  console.log('BEFORE CLEANUP:', JSON.stringify(before, null, 2));

  await authenticatedConsole.setFeedDate('20260908');
  const path = require('path');
  await authenticatedConsole.chooseFile(path.join(__dirname, '..', '..', 'data', 'feeds', 'ALLSTATE.LNA.BR-006-TRIGGER.D20260908.txt'));
  const runId = await authenticatedConsole.submitAndGetRunId();
  const run = await authenticatedConsole.waitForRunToSettle(runId);
  await new Promise((r) => setTimeout(r, 15000));

  const after = await withDb(async (client) => {
    const mc = await client.query('SELECT last_updated_date FROM adsi_master.master_control');
    const unprocessed = await client.query('SELECT count(*)::int AS n FROM pru_adb.activity_log_entry WHERE processed_ts IS NULL');
    return { mc: mc.rows[0], unprocessedAfter: unprocessed.rows[0].n };
  });
  // eslint-disable-next-line no-console
  console.log('AFTER CLEANUP + generic trigger cycle:', JSON.stringify({ runStatus: (run as any)?.status, ...after }, null, 2));
});
