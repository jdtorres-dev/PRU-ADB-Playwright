-- TC-BR-392 manual check: firm name change (READ ONLY).
-- Run in any Postgres client (DBeaver, pgAdmin, psql) connected with the .env details.
--
-- Set the BD id once, in the "params" line of each query. It comes from the
-- test's "before" firm name in artifacts/e2e-brv4/verdicts/TC-BR-392.json:
--   "E2E BRV4 BD50000 LLC"  ->  'A99' + '50000' + '00'  ->  A995000000
--
-- The whole script runs in a read-only transaction and ends with ROLLBACK,
-- so it cannot change anything.

BEGIN TRANSACTION READ ONLY;

-- 1. The firm's org code (the key of its master record)
WITH params AS (SELECT 'A995000000'::text AS bd)
SELECT c.allstate_id AS bd_id, o.org_code, o.node_id AS org_node_id
FROM params p
JOIN pru_adb.contract c           ON c.allstate_id = p.bd
JOIN pru_adb.node_relationship nr ON nr.child_node_id = c.node_id AND nr.relationship_type = 'ORG_TO_BD'
JOIN pru_adb.organization o       ON o.node_id = nr.parent_node_id;

-- 2. The master record NOW - org_full_name must be 'E2E BRV4 CHANGED FIRM NAME'.
--    The other columns are shown so you can confirm nothing else looks changed.
WITH params AS (SELECT 'A995000000'::text AS bd),
org AS (
  SELECT o.org_code
  FROM params p
  JOIN pru_adb.contract c           ON c.allstate_id = p.bd
  JOIN pru_adb.node_relationship nr ON nr.child_node_id = c.node_id AND nr.relationship_type = 'ORG_TO_BD'
  JOIN pru_adb.organization o       ON o.node_id = nr.parent_node_id
)
SELECT r.*
FROM adsi_master.organization_record r
JOIN org ON r.contract_number = org.org_code;

-- 3. The change marks - expect a Day 1 row (ORO0OR, written by UTP27101) and
--    a Day 2 row (ORO2OR, written by UTP27201, activity_ts on 2026-09-09).
WITH params AS (SELECT 'A995000000'::text AS bd),
org AS (
  SELECT o.org_code
  FROM params p
  JOIN pru_adb.contract c           ON c.allstate_id = p.bd
  JOIN pru_adb.node_relationship nr ON nr.child_node_id = c.node_id AND nr.relationship_type = 'ORG_TO_BD'
  JOIN pru_adb.organization o       ON o.node_id = nr.parent_node_id
)
SELECT a.activity_ts, a.transaction_code, a.purpose_code, a.subject_id, a.processed_ts, a.crt_by_id
FROM pru_adb.activity_log_entry a
JOIN org ON a.pru_contract_or_org_code = org.org_code
ORDER BY a.activity_ts;

ROLLBACK;
