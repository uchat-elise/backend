import test from 'node:test';
import assert from 'node:assert/strict';
import { getFriendRelationship } from '../src/friend-requests.js';

test('marks pending requests as pending', () => {
  const pendingRequests = [{ senderId: 'user-a', receiverId: 'user-b', status: 'pending' }];
  assert.equal(getFriendRelationship({ currentUserId: 'user-a', targetUserId: 'user-b', pendingRequests, friendsByUserId: new Map() }), 'pending');
});

test('marks accepted friendships as friends', () => {
  const friendsByUserId = new Map([['user-b', new Set(['user-a'])]]);
  assert.equal(getFriendRelationship({ currentUserId: 'user-a', targetUserId: 'user-b', pendingRequests: [], friendsByUserId }), 'friend');
});
