import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveReceiverSocketId, createMessagePayload, persistMessageWithTransaction } = await import('../src/message-flow.ts');

test('resolveReceiverSocketId reads the mapped socket id for the target user', () => {
  const socketMap = new Map([['user-2', 'socket-abc']]);
  assert.equal(resolveReceiverSocketId('user-2', socketMap), 'socket-abc');
  assert.equal(resolveReceiverSocketId('user-404', socketMap), null);
});

test('createMessagePayload includes required fields for emit and DB persistence', () => {
  const payload = createMessagePayload({
    id: 'msg-1',
    senderId: 'user-1',
    receiverId: 'user-2',
    content: 'hello',
    type: 'text',
    timestamp: '2026-08-16T00:00:00.000Z',
  });

  assert.deepEqual(payload, {
    id: 'msg-1',
    senderId: 'user-1',
    receiverId: 'user-2',
    content: 'hello',
    type: 'text',
    timestamp: '2026-08-16T00:00:00.000Z',
  });
});

test('persistMessageWithTransaction logs and emits only after save and last-message update complete', async () => {
  let saveCalled = 0;
  let updateCalled = 0;
  const socketMap = new Map([['user-2', 'socket-abc']]);

  const result = await persistMessageWithTransaction({
    saveMessage: async () => {
      saveCalled += 1;
      assert.equal(saveCalled, 1);
    },
    updateConversationLastMessage: async () => {
      updateCalled += 1;
      assert.equal(updateCalled, 1);
    },
    messageId: 'msg-2',
    senderId: 'user-1',
    receiverId: 'user-2',
    content: 'hi',
    type: 'text',
    timestamp: '2026-08-16T00:00:00.000Z',
    socketMap,
  });

  assert.equal(saveCalled, 1);
  assert.equal(updateCalled, 1);
  assert.equal(result.ok, true);
  assert.equal(result.offline, false);
  assert.equal(result.message.id, 'msg-2');
  assert.deepEqual(result.message, {
    id: 'msg-2',
    senderId: 'user-1',
    receiverId: 'user-2',
    content: 'hi',
    type: 'text',
    timestamp: '2026-08-16T00:00:00.000Z',
  });
});
