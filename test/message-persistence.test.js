import test from 'node:test';
import assert from 'node:assert/strict';

import { saveMessage, fetchUnreadMessages } from '../src/message-persistence.ts';

test('message persistence exports the required service functions', () => {
  assert.equal(typeof saveMessage, 'function');
  assert.equal(typeof fetchUnreadMessages, 'function');
});
