import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSocketAuthToken, verifySocketAuthToken, createSocketServer, getPrivateRoomId } from '../src/socket-server.ts';

test('getPrivateRoomId is stable regardless of initiator', () => {
  assert.equal(getPrivateRoomId('101', '102'), 'private_101_102');
  assert.equal(getPrivateRoomId('102', '101'), 'private_101_102');
});

test('getPrivateRoomId rejects invalid or self conversations', () => {
  assert.throws(() => getPrivateRoomId('101', '101'));
  assert.throws(() => getPrivateRoomId('', '102'));
});

test('parseSocketAuthToken reads bearer token from auth header or handshake auth', () => {
  assert.equal(parseSocketAuthToken({ headers: { authorization: 'Bearer test.jwt' } }), 'test.jwt');
  assert.equal(parseSocketAuthToken({ auth: { token: 'abc.def' } }), 'abc.def');
  assert.equal(parseSocketAuthToken({ headers: {}, auth: {} }), null);
});

test('verifySocketAuthToken rejects missing token', async () => {
  const result = await verifySocketAuthToken({ auth: {}, headers: {} }, null);
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing auth token/i);
});

test('createSocketServer creates a Socket.IO server instance', async () => {
  const server = await createSocketServer({ port: 0, path: '/socket.io' });
  assert.ok(server);
  assert.equal(typeof server.io.on, 'function');
  await server.close();
});
