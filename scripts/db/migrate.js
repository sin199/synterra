import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { applySingleWorldMigration, applyWorldSchemaAndMigrations, readWorldMigrationPlan } from '../../src/database-migrations.js';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const mode = args[0] || '--plan';
const migrationName = mode === '--migration' ? args[1] : null;

if (!['--plan', '--apply', '--migration'].includes(mode)
    || (mode === '--migration' && (!migrationName || args.length !== 2))
    || (mode !== '--migration' && args.length > 1)) {
  throw new TypeError('Use --plan, --apply, or --migration <numbered-file>.');
}

const plan = await readWorldMigrationPlan(rootDirectory);
if (mode === '--plan') {
  console.log(JSON.stringify({ mode: 'plan_only', migrations: plan.map(({ name, checksum }) => ({ name, checksum })) }, null, 2));
} else {
  const connectionString = process.env.SYNTERRA_MIGRATION_DATABASE_URL;
  if (!connectionString) {
    const error = new Error('Set SYNTERRA_MIGRATION_DATABASE_URL explicitly; DATABASE_URL is never used by this command.');
    error.code = 'MIGRATION_TARGET_REQUIRED';
    throw error;
  }
  if (process.env.SYNTERRA_MIGRATION_ACK !== 'I_CONFIRMED_TARGET_BACKUP_AND_WORLD_ID') {
    const error = new Error('Set the explicit migration acknowledgement only after backup and same-world identity checks.');
    error.code = 'MIGRATION_ACK_REQUIRED';
    throw error;
  }
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    if (mode === '--migration') {
      const result = await applySingleWorldMigration(pool, { rootDirectory, migrationName });
      console.log(JSON.stringify({ mode: 'single_migration', ...result }, null, 2));
    } else {
      const result = await applyWorldSchemaAndMigrations(pool, { rootDirectory });
      console.log(JSON.stringify({ mode: 'applied', ...result }, null, 2));
    }
  } finally {
    await pool.end();
  }
}
