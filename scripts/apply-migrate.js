import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlPath = path.join(__dirname, '..', 'supabase-schema.sql');

if (!fs.existsSync(sqlPath)) {
  console.error('Schema file not found:', sqlPath);
  process.exit(1);
}

const sql = fs.readFileSync(sqlPath, 'utf8').trim();

const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.SUPABASE_CONNECTION_STRING;

if (!dbUrl) {
  console.error('No database connection URL found. Set one of: DATABASE_URL, SUPABASE_DB_URL, SUPABASE_CONNECTION_STRING');
  process.exit(1);
}

const client = new Client({ connectionString: dbUrl });

const run = async () => {
  try {
    await client.connect();
    console.log('Connected to database. Running migration...');

    // Some Postgres setups allow multiple statements; if not, split by ';' safely.
    // We'll attempt a direct run first, falling back to splitting on semicolons.
    try {
      await client.query(sql);
      console.log('Migration executed successfully (single-statement run).');
    } catch (err) {
      console.log('Single-run failed, attempting statement-by-statement execution.');
      const statements = sql
        .split(/;\s*\n/)
        .map((s) => s.trim())
        .filter(Boolean);

      for (const stmt of statements) {
        try {
          await client.query(stmt);
        } catch (e) {
          console.error('Failed to run statement:', stmt.slice(0, 200));
          throw e;
        }
      }
      console.log('Migration executed successfully (statement-by-statement).');
    }
  } catch (error) {
    console.error('Migration failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await client.end();
  }
};

run();
