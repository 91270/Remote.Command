import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../dist/store.js';
import { Dashboard } from '../dist/dashboard.js';
import { DeviceFlow } from '../dist/device-flow.js';
import { hash, secret } from '../dist/protocol.js';

test('legacy v0.5.3 SQLite database migrates losslessly to schema_version=1 owned by initial admin', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-migrate-'));
  const file = join(temp, 'gateway.sqlite');
  try {
    // Construct a pre-multi-tenant v0.5.3 schema (user_version = 0, no user_id columns)
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, credential TEXT UNIQUE NOT NULL,
        caps TEXT NOT NULL, boot TEXT, seen INTEGER, last_seen INTEGER, platform TEXT, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE retired_boots (device TEXT NOT NULL, boot TEXT NOT NULL, PRIMARY KEY(device, boot));
      CREATE TABLE invites (digest TEXT PRIMARY KEY, name TEXT NOT NULL, caps TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, device TEXT NOT NULL, op TEXT NOT NULL, args TEXT NOT NULL,
        status TEXT NOT NULL, boot TEXT, created INTEGER NOT NULL, changed INTEGER NOT NULL, deadline INTEGER NOT NULL,
        cancel INTEGER NOT NULL DEFAULT 0, output TEXT, seq INTEGER NOT NULL DEFAULT 0, mcp_result TEXT, tool_name TEXT, background INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, event TEXT NOT NULL, details TEXT NOT NULL);
      CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE auth (digest TEXT PRIMARY KEY, kind TEXT NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE device_catalog (device TEXT PRIMARY KEY, catalog TEXT NOT NULL);
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE,
        role TEXT NOT NULL DEFAULT 'user', password_hash TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE user_identities (provider TEXT NOT NULL, provider_sub TEXT NOT NULL,
        user_id TEXT NOT NULL, email TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(provider, provider_sub));
      CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, client_secret_hash TEXT NOT NULL,
        client_name TEXT, redirect_uris TEXT NOT NULL, grant_types TEXT NOT NULL, response_types TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL, scope TEXT, created_at INTEGER NOT NULL);
    `);
    const devId = randomUUID();
    const taskId = randomUUID();
    const cred = secret();
    const now = Date.now();
    legacy.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?,?,?,0)').run(devId, 'legacy-mac', hash(cred), '["read"]', null, 0, now - 1000, 'darwin');
    legacy.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,0,?,1,NULL,?,0)').run(taskId, devId, 'dc_call', '{}', 'succeeded', null, now - 500, now - 400, now + 1000, 'ok', 'read_file');
    legacy.prepare('INSERT INTO auth VALUES(?,?,?,?)').run(hash(secret()), 'access', now + 60000, '{}');
    legacy.close();

    const store = new Store(file);
    try {
      const version = store.db.prepare('PRAGMA user_version').get().user_version;
      assert.equal(version, 1);
      const devices = store.devices();
      assert.equal(devices.length, 1);
      assert.equal(devices[0].id, devId);
      assert.ok(devices[0].userId, 'Legacy device must be assigned to initial admin');
      const admin = store.findUserById(devices[0].userId);
      assert.equal(admin.role, 'admin');
      assert.equal(store.task(taskId, admin.id)?.output, 'ok');
      // Legacy auth tokens without userId must be purged
      assert.equal(store.db.prepare("SELECT count(*) AS n FROM auth WHERE kind='access'").get().n, 0);
    } finally {
      store.db.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('multi-tenant isolation enforces strict boundaries between users across Store and Dashboard APIs', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-mt-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const flow = new DeviceFlow(store, 'http://127.0.0.1');
  let dashboard;
  const server = createServer(async (req, res) => {
    try {
      if (!await dashboard.route(req, res, new URL(req.url, origin))) res.writeHead(404).end();
    } catch { res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  dashboard = new Dashboard(store, { origin, googleEnabled: true }, flow);

  try {
    // Create User A (first Google user -> admin) and User B (invited regular user)
    const resA = store.createGoogleUser({ sub: 'sub-a', email: 'alice@example.com', displayName: 'Alice', avatarUrl: null, adminEmails: new Set() });
    assert.equal(resA.status, 'ok');
    assert.equal(resA.user.role, 'admin');
    const invite = store.createRegistrationInvite(resA.user.id, { maxUses: 1 });
    const resB = store.createGoogleUser({ sub: 'sub-b', email: 'bob@example.com', displayName: 'Bob', avatarUrl: null, adminEmails: new Set(), inviteCode: invite.code });
    assert.equal(resB.status, 'ok');
    assert.equal(resB.user.role, 'user');

    // Mint dashboard sessions for Alice and Bob
    const sessionFor = user => {
      const token = secret(), csrf = secret();
      store.putAuth(token, 'dashboard', 3600000, { csrf, userId: user.id, username: user.email, role: user.role });
      return (path, data) => fetch(origin + '/manage' + path, {
        ...(data !== undefined && { method: 'POST', body: JSON.stringify(data) }),
        headers: {
          Cookie: `rcm_dashboard=${token}`,
          ...(data !== undefined && { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf })
        }
      });
    };
    const reqA = sessionFor(resA.user);
    const reqB = sessionFor(resB.user);

    // Pair Device A for Alice and Device B for Bob
    const devA = store.pair(store.invite('Alice-Mac', ['read'], resA.user.id), secret());
    const devB = store.pair(store.invite('Bob-PC', ['read'], resB.user.id), secret());
    store.sync(devA.id, randomUUID(), 'darwin', []);
    store.sync(devB.id, randomUUID(), 'win32', []);

    const taskA = store.submit(devA.id, 'dc_call', { tool: 'read_file', arguments: { path: 'a.txt' } }, resA.user.id);
    const taskB = store.submit(devB.id, 'dc_call', { tool: 'read_file', arguments: { path: 'b.txt' } }, resB.user.id);

    // Store-level isolation checks
    assert.deepEqual(store.devices(resA.user.id).map(d => d.id), [devA.id]);
    assert.deepEqual(store.devices(resB.user.id).map(d => d.id), [devB.id]);
    assert.throws(() => store.submit(devA.id, 'dc_call', { tool: 'read_file', arguments: {} }, resB.user.id), /Unknown or revoked device/);
    assert.equal(store.task(taskA.id, resB.user.id), undefined);
    assert.throws(() => store.cancel(taskA.id, resB.user.id), /Unknown task/);

    // Dashboard API isolation checks
    const ovA = await (await reqA('/api/overview')).json();
    const ovB = await (await reqB('/api/overview')).json();
    assert.deepEqual(ovA.devices.map(d => d.id), [devA.id]);
    assert.deepEqual(ovB.devices.map(d => d.id), [devB.id]);

    // Bob cannot inspect, cancel, rename, or revoke Alice's resources
    assert.equal((await reqB(`/api/tasks/${taskA.id}`)).status, 404);
    assert.equal((await reqB(`/api/tasks/${taskA.id}/cancel`, {})).status, 404);
    assert.equal((await reqB(`/api/devices/${devA.id}/rename`, { name: 'Hacked' })).status, 404);
    assert.equal((await reqB(`/api/devices/${devA.id}/revoke`, {})).status, 404);

    // Bob's revoke-all only affects Bob's device, not Alice's
    const revB = await (await reqB('/api/devices/revoke-all', {})).json();
    assert.equal(revB.revokedDevices, 1);
    assert.equal(store.devices(resA.user.id)[0].revoked, false);
    assert.equal(store.devices(resB.user.id)[0].revoked, true);
    assert.equal(store.task(taskB.id, resB.user.id).status, 'interrupted');
    assert.equal(store.task(taskA.id, resA.user.id).status, 'queued');
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('in-memory liveSeen heartbeat avoids DB writes on steady sync and flushes on maintain', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-heartbeat-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  try {
    const dev = store.pair(store.invite('steady', ['read']), secret());
    const boot = randomUUID();
    store.sync(dev.id, boot, 'linux', []);
    const initialDbSeen = Number(store.db.prepare('SELECT seen FROM devices WHERE id=?').get(dev.id).seen);

    await new Promise(r => setTimeout(r, 25));
    const reply = store.sync(dev.id, boot, 'linux', []);
    assert.deepEqual(reply, { jobs: [], cancel: [], ack: [] });
    // Fast path should NOT have updated DB seen yet
    const dbSeenDuringFastPath = Number(store.db.prepare('SELECT seen FROM devices WHERE id=?').get(dev.id).seen);
    assert.equal(dbSeenDuringFastPath, initialDbSeen);
    assert.equal(store.devices()[0].online, true);

    // maintain() flushes dirty in-memory heartbeat to SQLite
    store.maintain();
    const flushedSeen = Number(store.db.prepare('SELECT seen FROM devices WHERE id=?').get(dev.id).seen);
    assert.ok(flushedSeen > initialDbSeen);

    // markOffline clears in-memory liveSeen immediately
    store.markOffline(dev.id, boot);
    assert.equal(store.devices()[0].online, false);
  } finally {
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});
