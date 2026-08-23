import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlPath = path.join(__dirname, '..', 'supabase-schema.sql');

if (!fs.existsSync(sqlPath)) {
  console.error('Schema file not found:', sqlPath);
  process.exit(1);
}

const sql = fs.readFileSync(sqlPath, 'utf8');
console.log('Migration script ready.');
console.log('Apply the following SQL to your database:');
console.log(sql);
