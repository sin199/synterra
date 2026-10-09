import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const databaseUrl = process.env.SYNTERRA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const formalWorldId = 'ce434421-8bcd-4aac-b9ba-183383c713de';

function assertIsolatedDatabase(connectionString) {
  const parsed = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname),
    'Genesis issuer migration regression requires loopback PostgreSQL');
  assert.notEqual(parsed.port, '5432', 'Genesis issuer migration regression must not use formal/default PostgreSQL');
  assert.ok(decodeURIComponent(parsed.pathname.slice(1)).endsWith('_test'),
    'Genesis issuer migration regression requires a *_test database');
}

test('0004 assigns the real Synterra-01 name as Generation 1 issuer', {
  skip: !enabled
}, async () => {
  assertIsolatedDatabase(databaseUrl);
  const migration = await readFile(path.join(repoRoot, 'migrations/0004_genesis_token_economy.sql'), 'utf8');
  const assignmentQuery = migration.match(/WITH named_issuer AS \([\s\S]*?ON CONFLICT\(world_id,capability_generation\) DO NOTHING;/)?.[0];
  assert.ok(assignmentQuery, '0004 contains the production issuer assignment query');

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const agentId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE agents (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TEMP TABLE world_members (world_id uuid NOT NULL, agent_id uuid NOT NULL);
      CREATE TEMP TABLE world_runtime_state (world_id uuid NOT NULL, world_minutes bigint NOT NULL);
      CREATE TEMP TABLE world_genesis_issuer_assignments (
        world_id uuid NOT NULL,
        capability_generation integer NOT NULL,
        issuer_agent_id uuid NOT NULL,
        selection_source text NOT NULL,
        assigned_world_minute bigint NOT NULL,
        PRIMARY KEY(world_id,capability_generation)
      );`);
    await client.query(`INSERT INTO agents(id,name) VALUES($1,'Synterra-01')`, [agentId]);
    await client.query(`INSERT INTO world_members(world_id,agent_id) VALUES($1,$2)`, [formalWorldId, agentId]);
    await client.query(`INSERT INTO world_runtime_state(world_id,world_minutes) VALUES($1,430807)`, [formalWorldId]);

    await client.query(assignmentQuery);
    const result = await client.query(`SELECT world_id,capability_generation,issuer_agent_id,
        selection_source,assigned_world_minute
      FROM world_genesis_issuer_assignments`);
    assert.deepEqual(result.rows, [{
      world_id: formalWorldId,
      capability_generation: 1,
      issuer_agent_id: agentId,
      selection_source: 'creator_genesis_assignment',
      assigned_world_minute: '430807'
    }]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
