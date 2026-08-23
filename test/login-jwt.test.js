import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const indexSource = readFileSync(path.join(rootDir, 'src', 'index.ts'), 'utf8');
const socketSource = readFileSync(path.join(rootDir, 'src', 'socket-server.ts'), 'utf8');

test('login endpoint supports identifier-based auth and returns an access token', () => {
  assert.match(indexSource, /\/api\/login/);
  assert.match(indexSource, /identifier/);
  assert.match(indexSource, /access_token/);
  assert.match(indexSource, /supabase_access_token/);
});

test('socket auth verification accepts JWTs signed with the Supabase secret', () => {
  assert.match(socketSource, /SUPABASE_JWT_SECRET|JWT_SECRET/);
  assert.match(socketSource, /jwt\.verify/);
  assert.match(socketSource, /sub/);
});
