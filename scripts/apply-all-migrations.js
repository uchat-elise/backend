import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, '..', 'migrations');
const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.SUPABASE_CONNECTION_STRING;

if (!dbUrl) {
  console.error('No database connection URL found. Set DATABASE_URL, SUPABASE_DB_URL, or SUPABASE_CONNECTION_STRING.');
  process.exit(1);
}

const migrationFiles = (await fs.readdir(migrationsDir))
  .filter((fileName) => fileName.endsWith('.sql'))
  .sort();

if (migrationFiles.length === 0) {
  console.log('No migration files found.');
  process.exit(0);
}

const client = new Client({ connectionString: dbUrl });

try {
  await client.connect();
  console.log(`Connected. Applying ${migrationFiles.length} migrations...`);

  for (const fileName of migrationFiles) {
    const sql = (await fs.readFile(path.join(migrationsDir, fileName), 'utf8')).trim();
    if (!sql) continue;

    console.log(`[migration] ${fileName}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      console.log(`[migration] applied ${fileName}`);
    } catch (error) {
      await client.query('ROLLBACK');
      const databaseError = error;
      const details = databaseError && typeof databaseError === 'object'
        ? [databaseError.message, databaseError.detail, databaseError.hint, databaseError.position ? `position ${databaseError.position}` : '']
          .filter(Boolean)
          .join(' | ')
        : String(error);
      throw new Error(`${fileName}: ${details}`);
    }
  }

  console.log('All migrations applied successfully.');
} catch (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
