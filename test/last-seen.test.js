import test from 'node:test';
import assert from 'node:assert/strict';
import { getVisibleLastSeen, shouldRefreshLastSeen } from '../src/last-seen.ts';

test('getVisibleLastSeen hides a timestamp when the other user hides it', () => {
  const currentUser = { id: 'u1', hide_last_seen: false, last_seen: '2026-08-16T00:00:00.000Z' };
  const otherUser = { id: 'u2', hide_last_seen: true, last_seen: '2026-08-16T00:10:00.000Z' };

  assert.equal(getVisibleLastSeen(currentUser, otherUser), null);
});

test('getVisibleLastSeen hides when the current user hides it, even if the other user is public', () => {
  const currentUser = { id: 'u1', hide_last_seen: true, last_seen: '2026-08-16T00:00:00.000Z' };
  const otherUser = { id: 'u2', hide_last_seen: false, last_seen: '2026-08-16T00:10:00.000Z' };

  assert.equal(getVisibleLastSeen(currentUser, otherUser), null);
});

test('shouldRefreshLastSeen only updates after the cooldown window', () => {
  const now = new Date('2026-08-16T00:00:20.000Z');
  assert.equal(shouldRefreshLastSeen(new Date('2026-08-16T00:00:10.000Z'), now), true);
  assert.equal(shouldRefreshLastSeen(new Date('2026-08-16T00:00:18.000Z'), now), false);
});
