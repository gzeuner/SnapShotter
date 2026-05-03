'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SerialTaskQueue } = require('../src/serialTaskQueue');

test('SerialTaskQueue executes tasks in FIFO order and supports whenIdle', async () => {
  const queue = new SerialTaskQueue();
  const events = [];

  const first = queue.enqueue(async () => {
    events.push('start-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.push('end-1');
    return 1;
  });

  const second = queue.enqueue(async () => {
    events.push('start-2');
    events.push('end-2');
    return 2;
  });

  assert.equal(await first, 1);
  assert.equal(await second, 2);
  await queue.whenIdle();

  assert.deepEqual(events, ['start-1', 'end-1', 'start-2', 'end-2']);
});
