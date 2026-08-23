import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureDemoUsersExist } from '../src/index.ts';

test('seeded demo accounts exist for the browser login flow', () => {
  const users = ensureDemoUsersExist([{ id: 'lowercase-demo', email: 'usera@example.com', username: 'usera', display_name: 'usera', profile_picture: null, created_at: '2024-01-01T00:00:00.000Z', password_hash: 'scrypt$test$abcd', email_verified: true, last_seen: null, hide_last_seen: false }]);
  const userA = users.find((user) => user.username.toLowerCase() === 'usera');
  const elise = users.find((user) => user.username.toLowerCase() === 'elise3');

  assert.ok(userA, 'userA should exist');
  assert.ok(elise, 'elise3 should exist');
  assert.equal(userA.username, 'userA');
  assert.equal(userA.email, 'userA@example.com');
  assert.equal(elise.username, 'elise3');
  assert.equal(elise.email, 'elise3@example.com');
});
