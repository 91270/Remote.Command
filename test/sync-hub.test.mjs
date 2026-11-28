import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SyncHub } from '../dist/sync-hub.js';

test('SyncHub wakes device waiters on events, supersedes older waiters, and handles aborts and shutdown', async () => {
  const hub = new SyncHub();
  assert.equal(hub.hasActiveWaiter('dev-1'), false);

  const startedAt = performance.now();
  const wait1 = hub.waitForDevice('dev-1', 'boot-a', true, 5000);
  assert.equal(hub.hasActiveWaiter('dev-1', 'boot-a'), true);
  assert.equal(hub.hasActiveWaiter('dev-1', 'boot-other'), false);

  await delay(20);
  assert.equal(hub.wakeDevice('dev-1', 'event'), true);
  assert.equal(await wait1, 'event');
  assert.ok(performance.now() - startedAt < 500);
  assert.equal(hub.hasActiveWaiter('dev-1'), false);
  assert.equal(hub.wakeDevice('dev-1', 'event'), false);

  // Newer long-poll waiter supersedes the older waiter on the same device
  const oldWaiter = hub.waitForDevice('dev-1', 'boot-a', true, 5000);
  const newWaiter = hub.waitForDevice('dev-1', 'boot-b', true, 5000);
  assert.equal(await oldWaiter, 'superseded');
  assert.equal(hub.hasActiveWaiter('dev-1', 'boot-b'), true);

  // Aborting signal settles cleanly with 'aborted'
  const abortController = new AbortController();
  const abortedWaiter = hub.waitForDevice('dev-2', 'boot-2', true, 5000, abortController.signal);
  abortController.abort();
  assert.equal(await abortedWaiter, 'aborted');

  // Timeout works cleanly for short waitMs
  assert.equal(await hub.waitForDevice('dev-timeout', 'boot-t', true, 25), 'timeout');

  // shutdown wakes remaining waiters immediately
  assert.equal(hub.wakeAll('shutdown'), 1);
  assert.equal(await newWaiter, 'shutdown');
  assert.equal(hub.hasActiveWaiter('dev-1'), false);
});

test('SyncHub waitForTaskEvent notifies immediately and rejects cleanly on AbortSignal', async () => {
  const hub = new SyncHub();
  let status = 'queued';

  const startedAt = performance.now();
  const pending = hub.waitForTaskEvent(
    'task-1',
    () => ({ id: 'task-1', status }),
    t => t.status === 'succeeded' || t.status === 'awaiting_approval',
    5000
  );

  setTimeout(() => {
    status = 'awaiting_approval';
    hub.notifyTask('task-1');
  }, 25);

  const reached = await pending;
  assert.equal(reached.status, 'awaiting_approval');
  assert.ok(performance.now() - startedAt < 500);

  // Timeout returns latest state without throwing
  status = 'running';
  const timedOut = await hub.waitForTaskEvent(
    'task-2',
    () => ({ id: 'task-2', status }),
    t => t.status === 'succeeded',
    30
  );
  assert.equal(timedOut.status, 'running');

  // AbortSignal rejects
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 15);
  await assert.rejects(
    () => hub.waitForTaskEvent('task-3', () => ({ id: 'task-3', status: 'queued' }), t => t.status === 'succeeded', 5000, ac.signal),
    { name: 'AbortError' }
  );
});
