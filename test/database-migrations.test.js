import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { applySingleWorldMigration, readWorldMigrationPlan } from '../src/database-migrations.js';

const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrationName = '0006_research_artifact_relations.sql';

function migrationPool({ applied = [] } = {}) {
  const calls = [];
  let ledger = applied.map(({ version, checksum }) => ({ version, checksum }));
  const client = {
    async query(sql, values = []) {
      calls.push({ sql: String(sql), values });
      if (sql === "SELECT to_regclass('public.synterra_schema_migrations') AS name") {
        return { rows: [{ name: 'synterra_schema_migrations' }] };
      }
      if (sql.includes('SELECT version,checksum FROM public.synterra_schema_migrations')) return { rows: ledger };
      if (sql.startsWith('INSERT INTO public.synterra_schema_migrations')) {
        ledger.push({ version: values[0], checksum: values[1] });
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
  return { calls, connect: async () => client };
}

test('selected migration path applies only the named migration without schema bootstrap', async () => {
  const plan = await readWorldMigrationPlan(rootDirectory);
  const target = plan.find((migration) => migration.name === migrationName);
  const pool = migrationPool({ applied: plan.slice(0, -1).map(({ name, checksum }) => ({ version: name, checksum })) });
  const result = await applySingleWorldMigration(pool, { rootDirectory, migrationName });
  assert.deepEqual(result, { applied: [migrationName], alreadyApplied: [], checksum: target.checksum });
  assert.equal(pool.calls.filter((call) => call.sql === target.sql).length, 1);
  assert.equal(pool.calls.some((call) => call.sql.includes('schema.sql')), false);
  assert.equal(pool.calls.filter((call) => call.sql.startsWith('INSERT INTO public.synterra_schema_migrations')).length, 1);
});

test('selected migration refuses to run when an earlier migration is absent', async () => {
  const pool = migrationPool();
  await assert.rejects(applySingleWorldMigration(pool, { rootDirectory, migrationName }),
    (error) => error.code === 'DATABASE_MIGRATION_PREREQUISITE_MISSING');
  const plan = await readWorldMigrationPlan(rootDirectory);
  const target = plan.find((migration) => migration.name === migrationName);
  assert.equal(pool.calls.some((call) => call.sql === target.sql), false);
});

test('selected migration is checksum-idempotent when already applied', async () => {
  const plan = await readWorldMigrationPlan(rootDirectory);
  const target = plan.find((migration) => migration.name === migrationName);
  const pool = migrationPool({ applied: plan.map(({ name, checksum }) => ({ version: name, checksum })) });
  const result = await applySingleWorldMigration(pool, { rootDirectory, migrationName });
  assert.deepEqual(result, { applied: [], alreadyApplied: [migrationName], checksum: target.checksum });
  assert.equal(pool.calls.some((call) => call.sql === target.sql), false);
});
