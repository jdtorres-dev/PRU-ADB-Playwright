import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// Isolated Postgres access for the BRv4 suite's DB-fixture test cases.
// Read-only by convention everywhere except the explicit seed functions below,
// which are scoped to exactly the rows a given test case names - never a
// broad UPDATE/DELETE. Connection details come from .env only.

function loadEnv(): Record<string, string> {
  const envPath = path.join(__dirname, '..', '.env');
  const env: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
    }
  }
  return env;
}

export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const env = loadEnv();
  const client = new Client({
    host: env.host,
    port: env.port ? Number(env.port) : undefined,
    user: env.user,
    password: env.pass,
    database: env.database,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
