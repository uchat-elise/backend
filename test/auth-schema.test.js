import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const source = readFileSync(path.join(rootDir, 'src', 'index.ts'), 'utf8');
const schema = readFileSync(path.join(rootDir, 'supabase-schema.sql'), 'utf8');

test('login queries preserve the compatibility avatar_url field and canonical profile_picture field', () => {
  assert.match(source, /profile_picture/);
  assert.match(source, /avatar_url/);
  assert.match(schema, /profile_picture/);
  assert.match(schema, /avatar_url/);
});
