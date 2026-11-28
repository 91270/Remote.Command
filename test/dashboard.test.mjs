import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Dashboard } from '../dist/dashboard.js';
import { OAuth } from '../dist/oauth.js';
import { RateLimiter } from '../dist/rate-limit.js';
import { Store } from '../dist/store.js';
import { secret, hash } from '../dist/protocol.js';

test('management dashboard Google session auth, CSRF, pairing, rename, tasks, audit, revocation and logout', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-dashboard-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const created = store.createGoogleUser({
    sub: 'sub-dashboard-admin',
    email: 'admin@example.com',
    displayName: 'Admin',
    avatarUrl: null,
    adminEmails: new Set()
  });
  assert.equal(created.status, 'ok');
  const admin = created.user;
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
  dashboard = new Dashboard(store, { origin }, { preview(code) {
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
    const landing = await fetch(origin + '/');
    assert.equal(landing.status, 200);
    const landingHtml = await landing.text();
    assert.match(landingHtml, /Remote\.Command/);
    assert.match(landing.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await fetch(origin + '/assets/landing.css')).status, 200);
    assert.equal((await fetch(origin + '/assets/landing.js')).status, 200);
    const page = await request('');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>Remote\.Command · 控制台<\/title>/);
    assert.match(html, /id="google-login-btn"/);
    assert.doesNotMatch(html, /type="password"/);
    assert.doesNotMatch(html, /password-login-fields/);
    assert.match(html, /id="device-start-ps"/);
    assert.match(html, /id="device-start-sh"/);
    assert.match(html, /id="prompt-library"/);
    assert.match(html, /data-prompt-cat="inspect"/);
    assert.match(html, /data-prompt-cat="files"/);
    assert.match(html, /data-prompt-cat="debug"/);
    assert.match(html, /data-prompt-cat="ops"/);
    assert.match(html, /id="chatgpt-troubleshoot"/);
    assert.match(html, /id="chatgpt-custom-instructions"/);
    assert.match(html, /id="usage-top-tools"/);
    assert.match(html, /id="usage-devices"/);
    assert.match(html, /id="usage-success-rate"/);
    assert.match(html, /id="usage-avg-duration"/);
    assert.match(html, /id="task-purged-notice"/);
    assert.match(html, /id="redeem-form"/);
    assert.match(html, /id="redeem-code-input"/);
    assert.match(html, /class="tasks-table"/);
    assert.match(html, /class="audit-table"/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const dashboardCssRes = await request('/assets/dashboard.css');
    assert.equal(dashboardCssRes.status, 200);
    const dashboardCss = await dashboardCssRes.text();
    assert.equal(dashboardCss.includes('grid-template-columns: minmax(0, 1fr)'), true);
    assert.equal(dashboardCss.includes('overflow-wrap: anywhere'), true);
    assert.equal(dashboardCss.includes('.audit-details'), true);
    const dashboardJsRes = await request('/assets/dashboard.js');
    assert.equal(dashboardJsRes.status, 200);
    const dashboardJs = await dashboardJsRes.text();
    for (const key of ['renderPromptLibrary', 'inspect', 'files', 'debug', 'ops']) {
      assert.equal(dashboardJs.includes(key), true, `dashboard.js missing ${key}`);
    }
    assert.equal(dashboardJs.includes('innerHTML'), false);
    assert.equal(dashboardJs.includes('/manage/api/login'), false);
    const authConfig = await (await request('/api/auth-config')).json();
    assert.deepEqual(authConfig, {
      googleEnabled: true,
      registrationMode: 'invite_only',
      initialized: true
    });
    assert.equal((await request('/api/overview')).status, 401);
    assert.equal((await request('/api/devices/revoke-all', {})).status, 401);
    assert.equal((await request('/api/login', { username: 'admin', password: 'wrong123' })).status, 401);
    const sessionToken = secret();
    csrf = secret();
    store.putAuth(sessionToken, 'dashboard', 3600000, {
      csrf,
      userId: admin.id,
      username: admin.email,
      role: admin.role
    });
    cookie = `rcm_dashboard=${sessionToken}`;
    assert.equal(store.db.prepare("SELECT kind FROM auth").get().kind, 'dashboard');
    assert.equal(store.db.prepare('SELECT digest FROM auth').get().digest, hash(sessionToken));
    assert.equal((await request('/api/login', { username: 'admin', password: 'wrong123' })).status, 404);
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
    for (const sensitive of [token, credential, csrf]) assert.equal(serialized.includes(sensitive), false);
    assert.equal((await request('/api/logout', {})).status, 200);
    assert.equal((await request('/api/session')).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('dashboard lists connected OAuth clients, tracks per-tenant activity, binds refresh tokens, and revokes per client', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-oauth-clients-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const staticClientId = 'static_mcp_client_1';
  const staticClientSecret = secret();
  const staticRedirect = 'https://chatgpt.com/static_connector_cb';
  let dashboard;
  let oauth;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === '/probe-mcp') {
        const auth = oauth.authenticateAccess(req);
        if (!auth) {
          oauth.challenge(res);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, userId: auth.userId ?? null }));
        return;
      }
      if (await oauth.route(req, res, url)) return;
      if (await dashboard.route(req, res, url)) return;
      res.writeHead(404).end();
    } catch {
      res.writeHead(500).end('Internal failure');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  oauth = new OAuth(store, {
    origin,
    ownerKey: secret(),
    clientId: staticClientId,
    clientSecret: staticClientSecret,
    redirects: new Set([staticRedirect]),
    googleEnabled: true
  });
  dashboard = new Dashboard(store, { origin, googleEnabled: true });

  const mintSession = user => {
    const token = secret();
    const csrf = secret();
    store.putAuth(token, 'dashboard', 3600000, {
      csrf,
      userId: user.id,
      username: user.email ?? user.username,
      role: user.role
    });
    const cookie = `rcm_dashboard=${token}`;
    const apiReq = (path, data, overrides = {}) => fetch(origin + '/manage' + path, {
      ...(data !== undefined && { method: 'POST', body: JSON.stringify(data) }),
      headers: {
        Cookie: cookie,
        ...(data !== undefined && { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
        ...overrides
      }
    });
    return { cookie, csrf, apiReq };
  };

  const authorizeWithSession = async (cookie, clientId, clientSecret, redirectUri) => {
    const verifier = secret() + secret();
    const challenge = hash(verifier);
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-' + secret().slice(0, 8),
      resource: origin + '/mcp',
      scope: 'remote:use'
    });
    const getRes = await fetch(origin + '/oauth/authorize?' + query.toString(), {
      headers: { Cookie: cookie }
    });
    assert.equal(getRes.status, 200);
    const html = await getRes.text();
    const hiddenInputs = [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)">/g)];
    const formData = new URLSearchParams();
    for (const [, k, v] of hiddenInputs) formData.set(k, v);
    assert.equal(formData.get('session_auth'), '1');

    const postRes = await fetch(origin + '/oauth/authorize', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie
      },
      body: formData
    });
    assert.equal(postRes.status, 303);
    const code = new URL(postRes.headers.get('location')).searchParams.get('code');
    assert.ok(code);

    const tokenRes = await fetch(origin + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
        resource: origin + '/mcp'
      })
    });
    assert.equal(tokenRes.status, 200);
    return tokenRes.json();
  };

  try {
    const aliceRes = store.createGoogleUser({
      sub: 'sub-alice-oauth',
      email: 'alice@example.com',
      displayName: 'Alice',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(aliceRes.status, 'ok');
    const invite = store.createRegistrationInvite(aliceRes.user.id, { maxUses: 1 });
    const bobRes = store.createGoogleUser({
      sub: 'sub-bob-oauth',
      email: 'bob@example.com',
      displayName: 'Bob',
      avatarUrl: null,
      adminEmails: new Set(),
      inviteCode: invite.code
    });
    assert.equal(bobRes.status, 'ok');

    const alice = mintSession(aliceRes.user);
    const bob = mintSession(bobRes.user);

    const regChatGPT = await (await fetch(origin + '/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect']
      })
    })).json();
    const regCodex = await (await fetch(origin + '/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Codex',
        redirect_uris: ['http://127.0.0.1:4567/callback']
      })
    })).json();

    const aliceChatGPT = await authorizeWithSession(
      alice.cookie,
      regChatGPT.client_id,
      regChatGPT.client_secret,
      'https://chatgpt.com/connector_platform_oauth_redirect'
    );
    const aliceCodex = await authorizeWithSession(
      alice.cookie,
      regCodex.client_id,
      regCodex.client_secret,
      'http://127.0.0.1:4567/callback'
    );
    const aliceStatic = await authorizeWithSession(
      alice.cookie,
      staticClientId,
      staticClientSecret,
      staticRedirect
    );

    const list1 = await (await alice.apiReq('/api/oauth/clients')).json();
    assert.equal(list1.clients.length, 3);
    const chatgptEntry1 = list1.clients.find(c => c.clientId === regChatGPT.client_id);
    const codexEntry1 = list1.clients.find(c => c.clientId === regCodex.client_id);
    const staticEntry1 = list1.clients.find(c => c.clientId === staticClientId);
    assert.equal(chatgptEntry1.clientName, 'ChatGPT');
    assert.deepEqual(chatgptEntry1.redirectOrigins, ['https://chatgpt.com']);
    assert.equal(chatgptEntry1.activeSessions, 1);
    assert.ok(chatgptEntry1.authorizedAt);
    assert.ok(chatgptEntry1.lastActiveAt);
    assert.ok(chatgptEntry1.expiresAt);
    assert.equal(codexEntry1.clientName, 'Codex');
    assert.deepEqual(codexEntry1.redirectOrigins, ['http://127.0.0.1:4567']);
    assert.equal(staticEntry1.clientName, 'Configured MCP Client');
    assert.deepEqual(staticEntry1.redirectOrigins, ['https://chatgpt.com']);

    // Activity via Bearer call updates lastActiveAt while keeping authorizedAt stable
    await new Promise(r => setTimeout(r, 20));
    const probeRes = await fetch(origin + '/probe-mcp', {
      headers: { Authorization: `Bearer ${aliceChatGPT.access_token}` }
    });
    assert.equal(probeRes.status, 200);
    assert.equal((await probeRes.json()).userId, aliceRes.user.id);

    // Refresh updates lastActiveAt for Codex while keeping authorizedAt constant
    await new Promise(r => setTimeout(r, 20));
    const wrongRefresh = await fetch(origin + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: aliceChatGPT.refresh_token,
        client_id: regCodex.client_id,
        client_secret: regCodex.client_secret,
        resource: origin + '/mcp'
      })
    });
    assert.equal(wrongRefresh.status, 400);
    assert.equal((await wrongRefresh.json()).error, 'invalid_grant');

    const codexRefreshedRes = await fetch(origin + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: aliceCodex.refresh_token,
        client_id: regCodex.client_id,
        client_secret: regCodex.client_secret,
        resource: origin + '/mcp'
      })
    });
    assert.equal(codexRefreshedRes.status, 200);
    const codexRefreshed = await codexRefreshedRes.json();

    const list2 = await (await alice.apiReq('/api/oauth/clients')).json();
    const chatgptEntry2 = list2.clients.find(c => c.clientId === regChatGPT.client_id);
    const codexEntry2 = list2.clients.find(c => c.clientId === regCodex.client_id);
    assert.equal(chatgptEntry2.authorizedAt, chatgptEntry1.authorizedAt);
    assert.ok(Date.parse(chatgptEntry2.lastActiveAt) > Date.parse(chatgptEntry1.lastActiveAt));
    assert.equal(codexEntry2.authorizedAt, codexEntry1.authorizedAt);
    assert.ok(Date.parse(codexEntry2.lastActiveAt) > Date.parse(codexEntry1.lastActiveAt));

    // Bob authorizes shared ChatGPT client
    const bobChatGPT = await authorizeWithSession(
      bob.cookie,
      regChatGPT.client_id,
      regChatGPT.client_secret,
      'https://chatgpt.com/connector_platform_oauth_redirect'
    );
    const bobList1 = await (await bob.apiReq('/api/oauth/clients')).json();
    assert.deepEqual(bobList1.clients.map(c => c.clientId), [regChatGPT.client_id]);

    // Alice activity on shared ChatGPT does not bleed into Bob's lastActiveAt
    await new Promise(r => setTimeout(r, 20));
    assert.equal((await fetch(origin + '/probe-mcp', {
      headers: { Authorization: `Bearer ${aliceChatGPT.access_token}` }
    })).status, 200);
    const bobList2 = await (await bob.apiReq('/api/oauth/clients')).json();
    assert.equal(bobList2.clients[0].lastActiveAt, bobList1.clients[0].lastActiveAt);

    // Bob cannot revoke Alice's Codex client
    assert.equal((await bob.apiReq(`/api/oauth/clients/${regCodex.client_id}/revoke`, {})).status, 404);

    // Validation & CSRF/Origin guards on per-client revoke
    assert.equal((await alice.apiReq(`/api/oauth/clients/${regChatGPT.client_id}/revoke`, {}, { 'X-CSRF-Token': secret() })).status, 403);
    assert.equal((await alice.apiReq(`/api/oauth/clients/${regChatGPT.client_id}/revoke`, {}, { Origin: 'https://elsewhere.example' })).status, 403);
    assert.equal((await alice.apiReq('/api/oauth/clients/bad!id/revoke', {})).status, 400);
    assert.equal((await alice.apiReq('/api/oauth/clients/unknown_client_id/revoke', {})).status, 404);

    // Bob revokes shared ChatGPT -> invalidates only Bob's tokens; Alice stays valid
    const bobRevoke = await bob.apiReq(`/api/oauth/clients/${regChatGPT.client_id}/revoke`, {});
    assert.equal(bobRevoke.status, 200);
    assert.deepEqual(await bobRevoke.json(), { ok: true, revokedTokens: 2 });
    assert.equal((await (await bob.apiReq('/api/oauth/clients')).json()).clients.length, 0);
    assert.equal((await fetch(origin + '/probe-mcp', {
      headers: { Authorization: `Bearer ${bobChatGPT.access_token}` }
    })).status, 401);
    assert.equal((await fetch(origin + '/probe-mcp', {
      headers: { Authorization: `Bearer ${aliceChatGPT.access_token}` }
    })).status, 200);

    // Alice revokes ChatGPT -> invalidates Alice's ChatGPT tokens while Codex & static client stay active
    const aliceRevoke = await alice.apiReq(`/api/oauth/clients/${regChatGPT.client_id}/revoke`, {});
    assert.equal(aliceRevoke.status, 200);
    assert.deepEqual(await aliceRevoke.json(), { ok: true, revokedTokens: 2 });
    assert.equal((await alice.apiReq(`/api/oauth/clients/${regChatGPT.client_id}/revoke`, {})).status, 404);
    assert.equal((await fetch(origin + '/probe-mcp', {
      headers: { Authorization: `Bearer ${aliceChatGPT.access_token}` }
    })).status, 401);
    const aliceRefreshRevoked = await fetch(origin + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: aliceChatGPT.refresh_token,
        client_id: regChatGPT.client_id,
        client_secret: regChatGPT.client_secret,
        resource: origin + '/mcp'
      })
    });
    assert.equal(aliceRefreshRevoked.status, 400);
    assert.equal((await aliceRefreshRevoked.json()).error, 'invalid_grant');

    assert.equal((await fetch(origin + '/probe-mcp', {
      headers: { Authorization: `Bearer ${codexRefreshed.access_token}` }
    })).status, 200);
    assert.equal((await fetch(origin + '/probe-mcp', {
      headers: { Authorization: `Bearer ${aliceStatic.access_token}` }
    })).status, 200);

    const remainingList = await (await alice.apiReq('/api/oauth/clients')).json();
    assert.equal(remainingList.clients.length, 2);
    assert.equal(remainingList.clients.some(c => c.clientId === regChatGPT.client_id), false);

    // Audit records oauth_client_revoked without leaking tokens or secrets
    const audit = await (await alice.apiReq('/api/audit')).json();
    const revokeEvent = audit.records.find(r => r.event === 'oauth_client_revoked');
    assert.ok(revokeEvent);
    assert.equal(revokeEvent.details.clientId, regChatGPT.client_id);
    assert.equal(revokeEvent.details.clientName, 'ChatGPT');
    assert.equal(revokeEvent.details.revokedTokens, 2);
    const serializedAudit = JSON.stringify(audit);
    for (const sensitive of [
      aliceChatGPT.access_token,
      aliceChatGPT.refresh_token,
      bobChatGPT.access_token,
      regChatGPT.client_secret,
      staticClientSecret
    ]) {
      assert.equal(serializedAudit.includes(sensitive), false);
    }

    // maintain() flushes live OAuth activity cleanly
    store.maintain();
    const persistedClient = store.findOAuthClient(regCodex.client_id);
    assert.ok(persistedClient?.lastUsedAt && persistedClient.lastUsedAt > 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('dashboard deletes individual revoked devices and clears revoked devices per tenant without touching active or task records', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-clear-revoked-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const aliceRes = store.createGoogleUser({
    sub: 'sub-alice-clear',
    email: 'alice-clear@example.com',
    displayName: 'Alice',
    avatarUrl: null,
    adminEmails: new Set()
  });
  store.setRegistrationMode('open');
  const bobRes = store.createGoogleUser({
    sub: 'sub-bob-clear',
    email: 'bob-clear@example.com',
    displayName: 'Bob',
    avatarUrl: null,
    adminEmails: new Set()
  });
  assert.equal(aliceRes.status, 'ok');
  assert.equal(bobRes.status, 'ok');
  const alice = aliceRes.user;
  const bob = bobRes.user;

  const dashboard = new Dashboard(store, { origin: 'http://127.0.0.1' });
  const server = createServer(async (req, res) => {
    try {
      const origin = 'http://127.0.0.1:' + server.address().port;
      const d = new Dashboard(store, { origin });
      if (!await d.route(req, res, new URL(req.url, origin))) res.writeHead(404).end();
    } catch {
      res.writeHead(500).end('Internal failure');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;

  const sessionToken = secret();
  const csrf = secret();
  store.putAuth(sessionToken, 'dashboard', 3600000, {
    csrf,
    userId: alice.id,
    username: alice.email,
    role: alice.role
  });
  const reqAsAlice = (path, data, overrides = {}) => fetch(origin + '/manage' + path, {
    ...(data !== undefined && { method: 'POST', body: JSON.stringify(data) }),
    headers: {
      ...(data !== undefined && { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
      Cookie: `rcm_dashboard=${sessionToken}`,
      ...overrides
    }
  });

  try {
    void dashboard;
    const activeDev = store.pair(store.invite('Alice-Active', ['read'], alice.id), secret());
    const revokedOne = store.pair(store.invite('Alice-Revoked-1', ['read'], alice.id), secret());
    const revokedTwo = store.pair(store.invite('Alice-Revoked-2', ['read'], alice.id), secret());
    const bobRevoked = store.pair(store.invite('Bob-Revoked', ['read'], bob.id), secret());

    // Populate retired_boots, device_catalog, and task history on revokedOne
    const bootId = randomUUID();
    store.sync(revokedOne.id, bootId, 'darwin', [], { tools: [], resources: [] });
    const oldTask = store.submit(revokedOne.id, 'dc_call', { tool: 'read_file', arguments: { path: 'a.txt' } }, alice.id);
    store.cancel(oldTask.id, alice.id);

    store.revoke(revokedOne.id, alice.id);
    store.revoke(revokedTwo.id, alice.id);
    store.revoke(bobRevoked.id, bob.id);

    // Auth & CSRF guards
    assert.equal((await fetch(origin + '/manage/api/devices/clear-revoked', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{}'
    })).status, 401);
    assert.equal((await reqAsAlice('/api/devices/clear-revoked', {}, { 'X-CSRF-Token': secret() })).status, 403);

    // Active device or another user's revoked device cannot be deleted
    assert.equal((await reqAsAlice(`/api/devices/${activeDev.id}/delete`, {})).status, 404);
    assert.equal((await reqAsAlice(`/api/devices/${bobRevoked.id}/delete`, {})).status, 404);

    // Delete one revoked device cleanly
    assert.equal((await reqAsAlice(`/api/devices/${revokedOne.id}/delete`, {})).status, 200);
    assert.equal(store.devices(alice.id).some(d => d.id === revokedOne.id), false);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM device_catalog WHERE device=?').get(revokedOne.id).n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM retired_boots WHERE device=?').get(revokedOne.id).n, 0);
    assert.equal(store.task(oldTask.id, alice.id)?.status, 'cancelled');

    // Deleting already-deleted device returns 404
    assert.equal((await reqAsAlice(`/api/devices/${revokedOne.id}/delete`, {})).status, 404);

    // Clear remaining revoked devices for Alice only
    const clearedRes = await reqAsAlice('/api/devices/clear-revoked', {});
    assert.equal(clearedRes.status, 200);
    assert.deepEqual(await clearedRes.json(), { ok: true, deletedDevices: 1 });

    // Alice keeps her active device; Bob keeps his revoked device
    assert.deepEqual(store.devices(alice.id).map(d => d.id), [activeDev.id]);
    assert.deepEqual(store.devices(bob.id).map(d => d.id), [bobRevoked.id]);

    // Clearing again when none left returns 0
    const clearedAgain = await (await reqAsAlice('/api/devices/clear-revoked', {})).json();
    assert.deepEqual(clearedAgain, { ok: true, deletedDevices: 0 });

    const audit = await (await reqAsAlice('/api/audit')).json();
    assert.equal(audit.records.some(r => r.event === 'device_deleted' && r.details.device === revokedOne.id), true);
    assert.equal(audit.records.some(r => r.event === 'devices_revoked_cleared' && r.details.deletedDevices === 1), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('dashboard sets approvalMode at invite/pairing time and switches it live per device with tenant isolation', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-approval-mode-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const aliceRes = store.createGoogleUser({ sub: 'sub-alice-am', email: 'alice-am@example.com', displayName: 'Alice', avatarUrl: null, adminEmails: new Set() });
  store.setRegistrationMode('open');
  const bobRes = store.createGoogleUser({ sub: 'sub-bob-am', email: 'bob-am@example.com', displayName: 'Bob', avatarUrl: null, adminEmails: new Set() });
  const alice = aliceRes.user;
  const bob = bobRes.user;
  const verified = [];
  const server = createServer(async (req, res) => {
    try {
      const origin = 'http://127.0.0.1:' + server.address().port;
      const d = new Dashboard(store, { origin }, {
        preview() { return undefined; },
        verify(code, name, caps, approve, userId, approvalMode) {
          verified.push({ code, approvalMode });
          return { status: 'approved', deviceName: name || 'Device' };
        }
      });
      if (!await d.route(req, res, new URL(req.url, origin))) res.writeHead(404).end();
    } catch { res.writeHead(500).end('Internal failure'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const session = user => {
    const token = secret();
    const csrf = secret();
    store.putAuth(token, 'dashboard', 3600000, { csrf, userId: user.id, username: user.email, role: user.role });
    return (path, data, overrides = {}) => fetch(origin + '/manage' + path, {
      ...(data !== undefined && { method: 'POST', body: JSON.stringify(data) }),
      headers: {
        ...(data !== undefined && { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
        Cookie: `rcm_dashboard=${token}`,
        ...overrides
      }
    });
  };
  const asAlice = session(alice);
  const asBob = session(bob);
  try {
    // Pairing-time selection through device-verify
    assert.equal((await asAlice('/api/device-verify', { user_code: 'ABCD-EFGH', capabilities: ['read'], approve: true, approvalMode: 'exec-only' })).status, 200);
    assert.equal(verified[0].approvalMode, 'exec-only');
    assert.equal((await asAlice('/api/device-verify', { user_code: 'ABCD-EFGH', capabilities: ['read'], approve: true, approvalMode: 'nonsense' })).status, 400);
    assert.equal((await asAlice('/api/device-verify', { user_code: 'ABCD-EFGH', capabilities: ['read'], approve: true })).status, 200);
    assert.equal(verified[1].approvalMode, 'client');

    // Invite-time selection persists onto the paired device
    const invite = await (await asAlice('/api/invites', { name: 'Strict box', capabilities: ['read', 'write'], approvalMode: 'strict' })).json();
    assert.equal(invite.approvalMode, 'strict');
    const paired = store.pair(invite.token, secret());
    assert.equal(paired.approvalMode, 'strict');
    assert.equal(store.devices(alice.id).find(d => d.id === paired.id).approvalMode, 'strict');

    // Live switching is reflected on both the heartbeat fast path and the full sync path
    const boot = randomUUID();
    assert.equal(store.sync(paired.id, boot, 'linux', []).approvalMode, 'strict');
    assert.equal(store.sync(paired.id, boot, 'linux', []).approvalMode, 'strict');
    assert.equal((await asAlice(`/api/devices/${paired.id}/approval-mode`, { approvalMode: 'client' }, { 'X-CSRF-Token': secret() })).status, 403);
    assert.equal((await asAlice(`/api/devices/${paired.id}/approval-mode`, { approvalMode: 'bogus' })).status, 400);
    const switched = await asAlice(`/api/devices/${paired.id}/approval-mode`, { approvalMode: 'client' });
    assert.equal(switched.status, 200);
    assert.deepEqual(await switched.json(), { ok: true, approvalMode: 'client' });
    assert.equal(store.sync(paired.id, boot, 'linux', []).approvalMode, 'client');
    assert.equal(store.devices(alice.id).find(d => d.id === paired.id).approvalMode, 'client');

    // Unified device policy endpoint switches capabilities + approvalMode live on fast path too
    assert.equal((await asAlice(`/api/devices/${paired.id}/policy`, { capabilities: ['read', 'read'], approvalMode: 'client' })).status, 400);
    const readonlyPolicy = await asAlice(`/api/devices/${paired.id}/policy`, { capabilities: ['read'], approvalMode: 'client' });
    assert.equal(readonlyPolicy.status, 200);
    assert.deepEqual(await readonlyPolicy.json(), { ok: true, capabilities: ['read'], approvalMode: 'client' });
    const fastSyncReadonly = store.sync(paired.id, boot, 'linux', []);
    assert.deepEqual(fastSyncReadonly.capabilities, ['read']);
    assert.equal(fastSyncReadonly.approvalMode, 'client');

    const safePolicy = await asAlice(`/api/devices/${paired.id}/policy`, { capabilities: ['read', 'write', 'exec'], approvalMode: 'exec-only' });
    assert.equal(safePolicy.status, 200);
    const fastSyncSafe = store.sync(paired.id, boot, 'linux', []);
    assert.deepEqual(fastSyncSafe.capabilities, ['read', 'write', 'exec']);
    assert.equal(fastSyncSafe.approvalMode, 'exec-only');

    // Tenant isolation and revoked devices
    assert.equal((await asBob(`/api/devices/${paired.id}/approval-mode`, { approvalMode: 'strict' })).status, 404);
    assert.equal((await asBob(`/api/devices/${paired.id}/policy`, { capabilities: ['read'], approvalMode: 'client' })).status, 404);
    assert.equal(store.devices(alice.id).find(d => d.id === paired.id).approvalMode, 'exec-only');
    store.revoke(paired.id, alice.id);
    assert.equal((await asAlice(`/api/devices/${paired.id}/approval-mode`, { approvalMode: 'strict' })).status, 404);
    assert.equal((await asAlice(`/api/devices/${paired.id}/policy`, { capabilities: ['read'], approvalMode: 'client' })).status, 404);

    const audit = await (await asAlice('/api/audit')).json();
    assert.equal(audit.records.some(r => r.event === 'device_approval_mode_updated' && r.details.approvalMode === 'client'), true);
    assert.equal(audit.records.some(r => r.event === 'device_policy_updated' && r.details.approvalMode === 'exec-only'), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('dashboard /manage/api/usage enforces tenant isolation, desensitization, and 80% monthly soft quota alerts', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-usage-api-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const aliceRes = store.createGoogleUser({ sub: 'sub-alice-u', email: 'alice-u@example.com', displayName: 'Alice', avatarUrl: null, adminEmails: new Set() });
  store.setRegistrationMode('open');
  const bobRes = store.createGoogleUser({ sub: 'sub-bob-u', email: 'bob-u@example.com', displayName: 'Bob', avatarUrl: null, adminEmails: new Set() });
  const alice = aliceRes.user;
  const bob = bobRes.user;
  const server = createServer(async (req, res) => {
    try {
      const origin = 'http://127.0.0.1:' + server.address().port;
      const d = new Dashboard(store, { origin, monthlySoftQuota: 5 });
      if (!await d.route(req, res, new URL(req.url, origin))) res.writeHead(404).end();
    } catch { res.writeHead(500).end('Internal failure'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const session = user => {
    const token = secret();
    const csrf = secret();
    store.putAuth(token, 'dashboard', 3600000, { csrf, userId: user.id, username: user.email, role: user.role });
    return path => fetch(origin + '/manage' + path, { headers: { Cookie: `rcm_dashboard=${token}` } });
  };
  const asAlice = session(alice);
  const asBob = session(bob);
  try {
    assert.equal((await fetch(origin + '/manage/api/usage')).status, 401);

    const devA = store.pair(store.invite('Alice-Mac', ['read', 'write'], alice.id), secret());
    const devB = store.pair(store.invite('Bob-PC', ['read'], bob.id), secret());
    store.sync(devA.id, randomUUID(), 'darwin', []);
    store.sync(devB.id, randomUUID(), 'win32', []);

    // 3 calls (< 80% of 5)
    for (let i = 0; i < 3; i++) {
      const task = store.submit(devA.id, 'dc_call', { tool: 'read_file', arguments: { path: `/secret/file-${i}.txt` } }, alice.id);
      store.finish(task.id, 'succeeded', `SENSITIVE_RESULT_${i}`);
    }
    const taskB = store.submit(devB.id, 'dc_call', { tool: 'list_directory', arguments: { path: '/bob' } }, bob.id);
    store.finish(taskB.id, 'failed', 'BOB_FAILURE');

    const okUsage = await (await asAlice('/api/usage')).json();
    assert.equal(okUsage.summary.monthCalls, 3);
    assert.equal(okUsage.summary.successRate30d, 100);
    assert.equal(okUsage.softQuota.status, 'ok');
    assert.equal(okUsage.softQuota.warning, false);
    assert.equal(okUsage.softQuota.blocking, false);
    const serialized = JSON.stringify(okUsage);
    assert.equal(serialized.includes('SENSITIVE_RESULT'), false);
    assert.equal(serialized.includes('/secret/file'), false);
    assert.equal(serialized.includes('BOB_FAILURE'), false);
    assert.equal(serialized.includes(devB.id), false);

    // 4th call reaches 80% soft warning threshold
    const task4 = store.submit(devA.id, 'dc_call', { tool: 'write_file', arguments: { path: '/secret/w.txt', content: 'hi' } }, alice.id);
    store.finish(task4.id, 'succeeded', 'ok');
    const warnOverview = await (await asAlice('/api/overview')).json();
    assert.equal(warnOverview.monthlyCalls, 4);
    assert.equal(warnOverview.softQuota.status, 'warning');
    assert.equal(warnOverview.softQuota.percent, 80);
    assert.equal(warnOverview.softQuota.warning, true);
    assert.equal(warnOverview.softQuota.blocking, false);

    // 5th call reaches 100% soft quota exceeded (still non-blocking)
    const task5 = store.submit(devA.id, 'dc_call', { tool: 'read_file', arguments: { path: '/secret/5.txt' } }, alice.id);
    store.finish(task5.id, 'failed', 'err');
    const exceededUsage = await (await asAlice('/api/usage')).json();
    assert.equal(exceededUsage.summary.monthCalls, 5);
    assert.equal(exceededUsage.topTools[0].toolName, 'read_file');
    assert.equal(exceededUsage.topTools[0].calls, 4);
    assert.equal(exceededUsage.deviceDistribution[0].deviceId, devA.id);
    assert.equal(exceededUsage.softQuota.status, 'exceeded');
    assert.equal(exceededUsage.softQuota.percent, 100);
    assert.equal(exceededUsage.softQuota.warning, true);
    assert.equal(exceededUsage.softQuota.blocking, false);

    // Bob's quota and usage remain isolated
    const bobUsage = await (await asBob('/api/usage')).json();
    assert.equal(bobUsage.summary.monthCalls, 1);
    assert.equal(bobUsage.summary.failedCalls30d, 1);
    assert.equal(bobUsage.softQuota.status, 'ok');
    assert.deepEqual(bobUsage.deviceDistribution.map(d => d.deviceId), [devB.id]);

    // Task detail endpoint reports payloadPurged cleanly after TTL purge without leaking prior output
    store.db.prepare('UPDATE tasks SET changed=? WHERE id=?').run(Date.now() - 45 * 60_000, task4.id);
    store.maintain(7, 90, 30, 210, 30);
    const purgedTaskRes = await asAlice('/api/tasks/' + task4.id);
    assert.equal(purgedTaskRes.status, 200);
    const purgedTask = await purgedTaskRes.json();
    assert.equal(purgedTask.id, task4.id);
    assert.equal(purgedTask.toolName, 'write_file');
    assert.equal(purgedTask.status, 'succeeded');
    assert.equal(purgedTask.payloadPurged, true);
    assert.ok(purgedTask.payloadPurgedAt);
    assert.equal(purgedTask.output, null);
    assert.equal(Object.hasOwn(purgedTask, 'result'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('dashboard /manage/api/plan and /manage/api/plan/redeem enforce CSRF, rate limiting, and instant Free->Pro upgrade', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-plan-api-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const rateLimiter = new RateLimiter({ rules: { redeem_code: { max: 3, windowMs: 60_000 } } });
  const adminRes = store.createGoogleUser({ sub: 'sub-p-admin', email: 'p-admin@example.com', displayName: 'Admin', avatarUrl: null, adminEmails: new Set() });
  store.setRegistrationMode('open');
  const userRes = store.createGoogleUser({ sub: 'sub-p-user', email: 'p-user@example.com', displayName: 'User', avatarUrl: null, adminEmails: new Set() });
  const user = userRes.user;
  const server = createServer(async (req, res) => {
    try {
      const origin = 'http://127.0.0.1:' + server.address().port;
      const d = new Dashboard(store, { origin, rateLimiter });
      if (!await d.route(req, res, new URL(req.url, origin))) res.writeHead(404).end();
    } catch { res.writeHead(500).end('Internal failure'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const token = secret();
  const csrf = secret();
  store.putAuth(token, 'dashboard', 3600000, { csrf, userId: user.id, username: user.email, role: user.role });
  const callApi = (path, data, overrides = {}) => fetch(origin + '/manage' + path, {
    ...(data !== undefined && { method: 'POST', body: JSON.stringify(data) }),
    headers: {
      Cookie: `rcm_dashboard=${token}`,
      ...(data !== undefined && { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }),
      ...overrides
    }
  });
  try {
    const plan1 = await (await callApi('/api/plan')).json();
    assert.equal(plan1.planQuota.plan, 'free');
    assert.equal(plan1.planQuota.limit, 10000);
    assert.deepEqual(plan1.redemptions, []);

    // CSRF protection
    assert.equal((await callApi('/api/plan/redeem', { code: 'PRO-AAAAA-BBBBB-CCCCC' }, { 'X-CSRF-Token': secret() })).status, 403);

    const validCode = store.createRedeemCode(adminRes.user.id, { tier: 'yearly', maxUses: 1 });

    // Invalid attempts count against rate limit
    assert.equal((await callApi('/api/plan/redeem', { code: 'PRO-BAD01-BAD02-BAD03' })).status, 400);
    assert.equal((await callApi('/api/plan/redeem', { code: 'PRO-BAD04-BAD05-BAD06' })).status, 400);

    // 3rd request succeeds and upgrades immediately
    const okRes = await callApi('/api/plan/redeem', { code: validCode.code });
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.ok, true);
    assert.equal(okBody.tier, 'yearly');
    assert.equal(okBody.durationDays, 365);
    assert.equal(okBody.planQuota.plan, 'pro');
    assert.ok(okBody.planQuota.planExpiresAt);
    assert.equal(okBody.redemptions.length, 1);
    assert.equal(okBody.redemptions[0].codePrefix, validCode.prefix);
    assert.equal(JSON.stringify(okBody).includes(validCode.code), false);

    // Session and overview reflect live Pro upgrade immediately
    const sessionBody = await (await callApi('/api/session')).json();
    assert.equal(sessionBody.plan, 'pro');
    assert.ok(sessionBody.planExpiresAt);
    const overviewBody = await (await callApi('/api/overview')).json();
    assert.equal(overviewBody.planQuota.plan, 'pro');

    // 4th attempt hits rate limit 429 with Retry-After
    const rlRes = await callApi('/api/plan/redeem', { code: validCode.code });
    assert.equal(rlRes.status, 429);
    assert.ok(Number(rlRes.headers.get('retry-after')) >= 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});
