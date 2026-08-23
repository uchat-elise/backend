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
    console.log('Connected to database. Applying schema from supabase-schema.sql...');

    try {
      await client.query(sql);
      console.log('Schema applied successfully.');
    } catch (error) {
      console.log('Direct execution failed, attempting statement-by-statement execution.');
      const statements = sql
        .split(/;\s*\n/)
        .map((statement) => statement.trim())
        .filter(Boolean);

      for (const statement of statements) {
        try {
          await client.query(statement);
        } catch (stmtError) {
          console.error('Failed statement:', statement.slice(0, 250));
          throw stmtError;
        }
      }

      console.log('Schema applied successfully via statement-by-statement execution.');
    }
  } catch (error) {
    console.error('Schema apply failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await client.end();
  }
};

run();
