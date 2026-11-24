import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Dashboard } from '../dist/dashboard.js';
import { Store } from '../dist/store.js';
import { secret, hash } from '../dist/protocol.js';

test('management dashboard owner login, CSRF, pairing, rename, tasks, audit, revocation and logout', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-dashboard-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const ownerKey = secret();
  let dashboard;
  const server = createServer(async (req, res) => {
    try {
      if (!await dashboard.route(req, res, new URL(req.url, origin))) res.writeHead(404).end();
    } catch { res.writeHead(500).end('Internal failure'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const verifications = [];
  dashboard = new Dashboard(store, { origin, ownerKey }, { preview(code) {
    if (code === 'ABCD-EFGH') return { deviceName: 'Desktop device', expiresAt: '2026-11-18T10:10:00Z' };
  }, verify(code, name, caps, approve) {
    if (code !== 'ABCD-EFGH') throw new Error('Unknown device code.');
    verifications.push({ code, name, caps, approve });
    return { status: approve ? 'approved' : 'denied', deviceName: name || 'Desktop device' };
  } });
  let cookie = '', csrf = '';
  const request = (path, data, overrides = {}) => fetch(origin + '/manage' + path, {
    ...(data !== undefined && { method: 'POST', body: JSON.stringify(data) }),
    headers: { ...(data !== undefined && { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
      ...(cookie && { Cookie: cookie }), ...overrides }
  });
  try {
    const page = await request('');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>Remote\.Command · 控制台<\/title>/);
    assert.match(html, /npx --yes --ignore-scripts --package=https:\/\/github\.com\/91270\/Remote\.Command\/releases\/download\/v[\d.]+\/remote-command-[\d.]+\.tgz remote-command remote/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await request('/assets/dashboard.js')).status, 200);
    assert.equal((await request('/api/overview')).status, 401);
    assert.equal((await request('/api/devices/revoke-all', {})).status, 401);
    assert.equal((await request('/api/login', { ownerKey: secret() })).status, 403);
    assert.equal((await request('/api/login', { ownerKey }, { Origin: 'https://elsewhere.example' })).status, 403);
    const login = await request('/api/login', { ownerKey });
    assert.equal(login.status, 200);
    const rawCookie = login.headers.get('set-cookie');
    assert.match(rawCookie, /^rcm_dashboard=/);
    assert.match(rawCookie, /HttpOnly; SameSite=Strict/);
    cookie = rawCookie.split(';')[0];
    csrf = (await login.json()).csrf;
    assert.equal(csrf.length, 43);
    assert.equal(store.db.prepare("SELECT kind FROM auth").get().kind, 'dashboard');
    assert.equal(store.db.prepare('SELECT digest FROM auth').get().digest, hash(cookie.split('=')[1]));
    const overview = await (await request('/api/overview')).json();
    assert.equal(overview.devices.length, 0);
    assert.equal(overview.totalCalls, 0);
    const inviteData = { name: 'Laptop', capabilities: ['read', 'write'] };
    assert.equal((await request('/api/invites', inviteData, { 'X-CSRF-Token': secret() })).status, 403);
    assert.equal((await request('/api/invites', { ...inviteData, capabilities: ['read', 'read'] })).status, 400);
    const verification = { user_code: 'ABCD-EFGH', capabilities: ['read', 'write'], approve: true };
    assert.equal((await request('/api/device-preview', { user_code: verification.user_code }, { 'X-CSRF-Token': secret() })).status, 403);
    const preview = await request('/api/device-preview', { user_code: verification.user_code });
    assert.deepEqual(await preview.json(), { deviceName: 'Desktop device', expiresAt: '2026-11-18T10:10:00Z' });
    assert.equal(verifications.length, 0);
    assert.equal((await request('/api/device-preview', { user_code: 'UNKN-OWNX' })).status, 404);
    assert.equal((await request('/api/device-verify', verification, { 'X-CSRF-Token': secret() })).status, 403);
    assert.equal((await request('/api/device-verify', { ...verification, user_code: 'UNKN-OWNX' })).status, 400);
    assert.equal((await request('/api/device-verify', verification)).status, 200);
    assert.deepEqual(verifications[0], { code: 'ABCD-EFGH', name: undefined, caps: ['read', 'write'], approve: true });
    assert.equal((await request('/api/device-verify', { ...verification, approve: false })).status, 200);
    assert.equal(verifications[1].approve, false);
    const invitation = await request('/api/invites', inviteData);
    assert.equal(invitation.status, 201);
    const { token } = await invitation.json();
    const credential = secret();
    const paired = store.pair(token, credential);
    assert.ok(paired);
    store.sync(paired.id, randomUUID(), 'linux', []);
    assert.equal((await request('/api/devices/' + paired.id + '/rename', { name: 'Build machine' })).status, 200);
    assert.equal(store.devices()[0].name, 'Build machine');
    const task = store.submit(paired.id, 'dc_call', { tool: 'read_file', arguments: { path: 'hello.txt' } });
    const listed = await (await request('/api/tasks?device=' + paired.id)).json();
    assert.equal(listed.tasks[0].id, task.id);
    assert.equal(Object.hasOwn(listed.tasks[0], 'output'), false);
    assert.equal((await request('/api/tasks/' + task.id + '/cancel', {})).status, 200);
    const cancelled = await (await request('/api/tasks/' + task.id)).json();
    assert.equal(cancelled.status, 'cancelled');
    assert.match(cancelled.output, /Cancelled before dispatch/);
    assert.equal((await request('/api/devices/' + paired.id + '/revoke', {})).status, 200);
    assert.equal(store.devices()[0].revoked, true);
    assert.equal((await request('/api/devices/' + paired.id + '/rename', { name: 'Again' })).status, 404);
    const secondCredential = secret();
    const second = store.pair(store.invite('Second', ['read']), secondCredential);
    store.sync(second.id, randomUUID(), 'linux', []);
    const thirdCredential = secret();
    const third = store.pair(store.invite('Third', ['read']), thirdCredential);
    const pendingTask = store.submit(second.id, 'dc_call', { tool: 'read_file', arguments: { path: 'pending.txt' } });
    const pendingInvite = store.invite('Pending', ['read']);
    store.db.prepare('INSERT INTO auth VALUES(?,?,?,?)').run(hash(secret()), 'device-enrollment', Date.now() + 60000, '{}');
    store.db.prepare('INSERT INTO auth VALUES(?,?,?,?)').run(hash(secret()), 'access', Date.now() + 60000, '{}');
    assert.equal((await request('/api/devices/revoke-all', {}, { 'X-CSRF-Token': secret() })).status, 403);
    assert.equal((await request('/api/devices/revoke-all', {}, { Origin: 'https://elsewhere.example' })).status, 403);
    const revoked = await request('/api/devices/revoke-all', {});
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), { revokedDevices: 2, invalidatedPairings: 2 });
    assert.equal(store.deviceByToken(secondCredential), undefined);
    assert.equal(store.deviceByToken(thirdCredential), undefined);
    assert.equal(store.devices().find(device => device.id === third.id).revoked, true);
    assert.equal(store.pair(pendingInvite, secret()), undefined);
    assert.equal(store.task(pendingTask.id).status, 'interrupted');
    assert.equal(store.task(task.id).status, 'cancelled');
    assert.equal((await request('/api/session')).status, 200);
    assert.equal(Number(store.db.prepare("SELECT count(*) AS n FROM auth WHERE kind='access'").get().n), 1);
    assert.deepEqual(await (await request('/api/devices/revoke-all', {})).json(), { revokedDevices: 0, invalidatedPairings: 0 });
    assert.equal((await request('/api/oauth/revoke', {})).status, 200);
    assert.equal(Number(store.db.prepare("SELECT count(*) AS n FROM auth WHERE kind='access'").get().n), 0);
    const audit = await (await request('/api/audit')).json();
    const serialized = JSON.stringify(audit);
    assert.match(serialized, /devices_revoked_all/);
    for (const sensitive of [ownerKey, token, credential, csrf]) assert.equal(serialized.includes(sensitive), false);
    assert.equal((await request('/api/logout', {})).status, 200);
    assert.equal((await request('/api/session')).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});
