import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const DATABASE_MIGRATION_LOCK = 'synterra-database-migrations-v1';

export async function readWorldMigrationPlan(rootDirectory) {
  const directory = path.join(rootDirectory, 'migrations');
  const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(path.join(directory, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

export async function applyWorldSchemaAndMigrations(pool, { rootDirectory }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required to apply Synterra schema migrations.');
  }
  if (typeof rootDirectory !== 'string' || !rootDirectory) throw new TypeError('Repository root is required.');

  const schema = await readFile(path.join(rootDirectory, 'schema.sql'), 'utf8');
  await pool.query(schema);

  const migrations = await readWorldMigrationPlan(rootDirectory);
  const client = await pool.connect();
  const applied = [];
  const alreadyApplied = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS synterra_schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [DATABASE_MIGRATION_LOCK]);
    try {
      for (const migration of migrations) {
        const existing = await client.query('SELECT checksum FROM synterra_schema_migrations WHERE version=$1', [migration.name]);
        if (existing.rowCount) {
          if (existing.rows[0].checksum !== migration.checksum) {
            const error = new Error(`Applied migration checksum changed: ${migration.name}.`);
            error.code = 'DATABASE_MIGRATION_CHECKSUM_MISMATCH';
            throw error;
          }
          alreadyApplied.push(migration.name);
          continue;
        }
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO synterra_schema_migrations(version,checksum) VALUES($1,$2)',
            [migration.name, migration.checksum]);
          await client.query('COMMIT');
          applied.push(migration.name);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [DATABASE_MIGRATION_LOCK]);
    }
  } finally { client.release(); }
  return { applied, alreadyApplied };
}
