import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { endpoint, secret, syncReply } from '../dist/protocol.js';

test('store: invites, capability checks, lost responses, replacement, terminal acknowledgement and revocation', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rcm-store-'));
  const db = new Store(join(tmp, 'state.sqlite'));
  try {
    const invite = db.invite('test', ['read']);
    const credential = secret(), agent = db.pair(invite, credential);
    assert.ok(agent);
    assert.equal(db.pair(invite, secret()), undefined);
    const expired = db.invite('unused', ['read']);
    db.db.exec('UPDATE invites SET expires=0');
    assert.equal(db.pair(expired, secret()), undefined);
    assert.throws(() => db.submit(agent.id, 'dc_call', { tool: 'read_file', arguments: { path: 'file' } }), /offline/);
    const boot = randomUUID();
    db.sync(agent.id, boot, 'darwin', []);
    assert.throws(() => db.submit(agent.id, 'dc_call', { tool: 'write_file', arguments: {} }), /not paired/);
    const a = db.submit(agent.id, 'dc_call', { tool: 'read_file', arguments: { path: 'file' } });
    const b = db.submit(agent.id, 'dc_call', { tool: 'read_file', arguments: { path: 'other' } });
    const c = db.submit(agent.id, 'dc_call', { tool: 'read_file', arguments: { path: 'never' } });
    assert.equal(db.cancel(c.id).status, 'cancelled');
    let reply = db.sync(agent.id, boot, 'darwin', []);
    assert.deepEqual(new Set(reply.jobs.map(j => j.id)), new Set([a.id, b.id]));
    assert.deepEqual(db.sync(agent.id, boot, 'darwin', []), reply);
    db.sync(agent.id, boot, 'darwin', [{ id: a.id, seq: 3, status: 'running', output: 'in progress' }]);
    db.sync(agent.id, boot, 'darwin', [{ id: a.id, seq: 2, status: 'running', output: 'stale' }]);
    assert.equal(db.task(a.id).output, 'in progress');
    const done = { id: a.id, seq: 4, status: 'succeeded', output: 'done' };
    assert.deepEqual(db.sync(agent.id, boot, 'darwin', [done]).ack, [a.id]);
    assert.deepEqual(db.sync(agent.id, boot, 'darwin', [done]).ack, [a.id]);
    const newBoot = randomUUID();
    assert.deepEqual(db.sync(agent.id, newBoot, 'darwin', []).jobs, []);
    assert.equal(db.task(b.id).status, 'interrupted');
    assert.equal(db.sync(agent.id, boot, 'darwin', []), undefined);
    assert.equal(db.revoke(agent.id), true);
    assert.equal(db.deviceByToken(credential), undefined);
    const audit = JSON.stringify(db.db.prepare('SELECT * FROM audit').all());
    assert.match(audit, /task_dispatched/);
    assert.doesNotMatch(audit, /"path"|in progress|never/);
    assert.equal(audit.includes(credential), false);
    assert.equal(db.totalCalls(), 3);
    db.db.exec('UPDATE audit SET at=0');
    db.maintain();
    assert.equal(db.db.prepare('SELECT count(*) AS n FROM audit').get().n, 0);
    assert.equal(db.totalCalls(), 3);
  } finally { db.db.close(); rmSync(tmp, { recursive: true, force: true }); }
});
test('endpoint: HTTPS and explicit IPv4 loopback only', () => {
  assert.equal(endpoint('https://example.com').origin, 'https://example.com');
  assert.equal(endpoint('http://127.0.0.1:8181', true).origin, 'http://127.0.0.1:8181');
  for (const s of ['http://127.0.0.1:8181/path', 'http://example.com', 'https://x@y.com', 'https://example.com/?q=secret'])
    assert.throws(() => endpoint(s, true), /HTTPS origin/);
});

test('task history upgrade preserves existing devices and results', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rcm-history-'));
  const file = join(tmp, 'state.sqlite');
  let store = new Store(file);
  try {
    const credential = secret();
    const { id: device } = store.pair(store.invite('fixture', ['read']), credential);
    store.sync(device, randomUUID(), 'linux', []);
    const lastSeen = store.devices()[0].lastSeen;
    const task = store.submit(device, 'dc_call', { tool: 'read_file', arguments: { path: 'hello.txt' } });
    store.finish(task.id, 'succeeded', 'retained output');
    store.db.exec('ALTER TABLE tasks DROP COLUMN tool_name; ALTER TABLE tasks DROP COLUMN background; ALTER TABLE devices DROP COLUMN last_seen');
    store.db.close();

    store = new Store(file);
    assert.equal(store.deviceByToken(credential).id, device);
    assert.equal(store.devices()[0].lastSeen, lastSeen);
    assert.equal(store.view(store.task(task.id)).output, 'retained output');
    assert.deepEqual(store.backgroundCalls(10), []);
  } finally { store.db.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test('unready executors hold queued tasks and an old boot cannot mark its replacement offline', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rcm-readiness-'));
  const store = new Store(join(folder, 'gateway.sqlite'));
  try {
    const credential = secret();
    const device = store.pair(store.invite('ready-device', ['read']), credential).id;
    const oldBoot = randomUUID();
    const boot = randomUUID();
    store.sync(device, oldBoot, 'darwin', []);
    store.sync(device, boot, 'darwin', []);
    store.markOffline(device, oldBoot);
    assert.equal(store.devices()[0].online, true);

    const job = store.submit(device, 'dc_call', { tool: 'read_file', arguments: { path: 'hello.txt' } });
    assert.deepEqual(store.sync(device, boot, 'darwin', [], undefined, false).jobs, []);
    assert.equal(store.devices()[0].online, false);
    assert.ok(store.devices()[0].lastSeen);
    assert.equal(store.task(job.id).status, 'queued');
    assert.deepEqual(store.sync(device, boot, 'darwin', []).jobs.map(task => task.id), [job.id]);
    const lastSeen = store.devices()[0].lastSeen;
    store.markOffline(device, boot);
    assert.equal(store.devices()[0].online, false);
    assert.equal(store.devices()[0].lastSeen, lastSeen);
    assert.equal(store.task(job.id).status, 'interrupted');
  } finally { store.db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('unsupported stored tasks never block current Agent work or erase completed results', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rcm-unsupported-task-'));
  const store = new Store(join(folder, 'gateway.sqlite'));
  try {
    const device = store.pair(store.invite('fixture', ['read']), secret()).id;
    const boot = randomUUID();
    store.sync(device, boot, 'linux', []);
    const args = { tool: 'read_file', arguments: { path: 'hello.txt' } };
    const queued = store.submit(device, 'dc_call', args);
    const dispatched = store.submit(device, 'dc_call', args);
    const completed = store.submit(device, 'dc_call', args);
    const current = store.submit(device, 'dc_call', args);
    store.finish(completed.id, 'succeeded', 'retained');
    store.db.prepare('UPDATE tasks SET op=? WHERE id IN (?,?,?)').run('unknown_operation', queued.id, dispatched.id, completed.id);
    store.db.prepare("UPDATE tasks SET status='dispatched',boot=? WHERE id=?").run(boot, dispatched.id);

    const reply = syncReply.parse(store.sync(device, boot, 'linux', []));
    assert.deepEqual(reply.jobs.map(job => job.id), [current.id]);
    assert.equal(store.task(queued.id).status, 'interrupted');
    assert.equal(store.task(dispatched.id).status, 'interrupted');
    assert.equal(store.task(completed.id).output, 'retained');
  } finally { store.db.close(); rmSync(folder, { recursive: true, force: true }); }
});
