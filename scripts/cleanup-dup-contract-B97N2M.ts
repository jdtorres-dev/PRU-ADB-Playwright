// One-off cleanup for the 2026-10-01 BRv4 run: removes the duplicate
// contract B97N2M (node 75015) that TC-BR-376's old construction made HR1
// appoint under contract A's allstate_id (P995078100, already held by
// B97N2K). That duplicate made every HR2 sync for feed date 2026-09-09 fail,
// blocking 38 TCs. TC-BR-376 no longer creates it (see otherContractsCase).
//
// Backs every affected row up to artifacts/reports first, refuses to run
// unless the DB is in exactly the expected state, and deletes in one
// transaction.
//
//   npx tsx scripts/cleanup-dup-contract-B97N2M.ts
import * as fs from 'fs';
import * as path from 'path';
import { withDb } from '../utils/db.brv4';

const NODE = 75015;
const CODE = 'B97N2M';
const MASTER = '97N2M';
const ALLSTATE_ID = 'P995078100';

// Child tables first, node last (FKs: contract -> node, history -> contract).
const STEPS: [string, string, any[]][] = [
  ['pru_adb.activity_log_entry', 'pru_contract_or_org_code = $1', [CODE]],
  ['pru_adb.address', 'ssn_or_contract_number = $1', [CODE]],
  ['pru_adb.contract_history', 'node_id = $1', [NODE]],
  ['pru_adb.node_relationship_history', 'child_node_id = $1 OR parent_node_id = $1', [NODE]],
  ['pru_adb.node_relationship', 'child_node_id = $1 OR parent_node_id = $1', [NODE]],
  ['pru_adb.legacy_oa_contract', 'contract_number IN ($1, $2)', [CODE, MASTER]],
  ['adsi_master.contract_record', 'contract_number = $1', [MASTER]],
  ['pru_adb.contract', 'node_id = $1 AND pru_contract_number = $2', [NODE, CODE]],
  ['pru_adb.node', 'node_id = $1', [NODE]],
];

(async () => {
  await withDb(async (client) => {
    const dup = await client.query('SELECT pru_contract_number FROM pru_adb.contract WHERE allstate_id = $1 ORDER BY 1', [ALLSTATE_ID]);
    const found = dup.rows.map((r) => r.pru_contract_number).join(',');
    if (found !== 'B97N2K,B97N2M') {
      console.log(`Nothing to do or unexpected state - contracts for ${ALLSTATE_ID}: [${found}]`);
      return;
    }

    const backup: Record<string, any[]> = {};
    for (const [table, where, params] of STEPS) backup[table] = (await client.query(`SELECT * FROM ${table} WHERE ${where}`, params)).rows;
    const out = path.join(__dirname, '..', 'artifacts', 'reports', 'cleanup-backup-B97N2M-20261001.json');
    fs.writeFileSync(out, JSON.stringify({ takenAt: new Date().toISOString(), reason: 'duplicate contract B97N2M poisoning HR2 2026-09-09', backup }, null, 1));
    console.log(`Backup written: ${out}`);

    await client.query('BEGIN');
    try {
      for (const [table, where, params] of STEPS) {
        const r = await client.query(`DELETE FROM ${table} WHERE ${where}`, params);
        console.log(`${table}: deleted ${r.rowCount} (backed up ${backup[table].length})`);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
    const left = await client.query('SELECT count(*) FROM pru_adb.contract WHERE allstate_id = $1', [ALLSTATE_ID]);
    console.log(`Contracts left for ${ALLSTATE_ID}: ${left.rows[0].count} (expected 1)`);
  });
})();
