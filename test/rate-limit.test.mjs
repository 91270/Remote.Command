import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { RateLimiter, clientIp } from '../dist/rate-limit.js';
import { Store } from '../dist/store.js';
import { Dashboard } from '../dist/dashboard.js';
import { OAuth } from '../dist/oauth.js';
import { GoogleAuth } from '../dist/google-auth.js';
import { DeviceFlow } from '../dist/device-flow.js';
import { agentClientId, hash, secret } from '../dist/protocol.js';

test('RateLimiter enforces sliding window, Retry-After, clock recovery, reset, and maxKeys eviction', () => {
  let now = 1_000_000;
  const limiter = new RateLimiter({
    now: () => now,
    maxKeys: 100,
    rules: { login_failure: { max: 2, windowMs: 10_000 } }
  });

  assert.equal(limiter.check('login_failure', 'k1').allowed, true);
  assert.equal(limiter.consume('login_failure', 'k1').remaining, 1);
  assert.equal(limiter.consume('login_failure', 'k1').remaining, 0);

  const blocked = limiter.consume('login_failure', 'k1');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSec, 10);

  // Advance clock past window expiration -> window recovers
  now += 10_001;
  assert.equal(limiter.check('login_failure', 'k1').allowed, true);
  assert.equal(limiter.consume('login_failure', 'k1').remaining, 1);

  // Reset clears count immediately
  limiter.reset('login_failure', 'k1');
  assert.equal(limiter.check('login_failure', 'k1').remaining, 2);

  // Fill beyond maxKeys (100) and verify bounded size
  for (let i = 0; i < 150; i++) {
    limiter.consume('login_failure', `flood-${i}`);
  }
  assert.ok(limiter.size() <= 100);
});

test('clientIp ignores spoofed proxy headers unless TRUST_PROXY=1 behind a private/loopback hop', () => {
  const fakeReq = (remoteAddress, headers = {}) => ({
    socket: { remoteAddress },
    headers
  });

  // trustProxy=false ignores X-Forwarded-For even from loopback
  assert.equal(
    clientIp(fakeReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), false),
    '127.0.0.1'
  );

  // trustProxy=true ignores X-Forwarded-For when remoteAddress is public (spoof attempt)
  assert.equal(
    clientIp(fakeReq('198.51.100.7', { 'x-forwarded-for': '203.0.113.9' }), true),
    '198.51.100.7'
  );

  // trustProxy=true behind loopback strips spoofed left-most IP and picks right-most non-private IP
  assert.equal(
    clientIp(fakeReq('::ffff:127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 203.0.113.5' }), true),
    '203.0.113.5'
  );

  // Falls back to X-Real-IP when X-Forwarded-For is absent
  assert.equal(
    clientIp(fakeReq('172.18.0.2', { 'x-real-ip': '203.0.113.42' }), true),
    '203.0.113.42'
  );
});

test('Dashboard login enforces brute-force backoff (429 + Retry-After), resets on success, and audits without password', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-rl-login-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const admin = store.ensureInitialAdmin();
  assert.ok(admin);
  const limiter = new RateLimiter({ rules: { login_failure: { max: 2, windowMs: 60_000 } } });
  let dashboard;
  const server = createServer(async (req, res) => {
    try {
      if (!await dashboard.route(req, res, new URL(req.url, origin))) res.writeHead(404).end();
    } catch { res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  dashboard = new Dashboard(store, { origin, rateLimiter: limiter });

  const postLogin = (username, password) => fetch(origin + '/manage/api/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  try {
    // 1 failure followed by 1 valid login resets the failure counter
    assert.equal((await postLogin('admin', 'wrongpass1')).status, 403);
    assert.equal((await postLogin('admin', admin.password)).status, 200);

    // Now 2 consecutive failures trigger 429 on the 3rd attempt even with the right password
    assert.equal((await postLogin('admin', 'wrongpass2')).status, 403);
    assert.equal((await postLogin('admin', 'wrongpass3')).status, 403);
    const blocked = await postLogin('admin', admin.password);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);

    const audits = store.recentAudit(20);
    const rlAudit = audits.find(a => a.event === 'rate_limited');
    assert.ok(rlAudit);
    assert.equal(rlAudit.details.bucket, 'login_failure');
    assert.equal(rlAudit.details.route, '/manage/api/login');
    const serialized = JSON.stringify(audits);
    assert.equal(serialized.includes('wrongpass'), false);
    assert.equal(serialized.includes(admin.password), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('OAuth /oauth/register and /oauth/authorize enforce rate limits with CORS and Retry-After', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-rl-oauth-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const admin = store.ensureInitialAdmin();
  assert.ok(admin);
  const limiter = new RateLimiter({
    rules: {
      oauth_register: { max: 1, windowMs: 60_000 },
      login_failure: { max: 2, windowMs: 60_000 }
    }
  });
  let oauth;
  const server = createServer(async (req, res) => {
    try {
      if (await oauth.route(req, res, new URL(req.url, origin))) return;
      res.writeHead(404).end();
    } catch { res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  oauth = new OAuth(store, { origin, ownerKey: secret(), rateLimiter: limiter });

  try {
    const regBody = JSON.stringify({
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect']
    });
    const r1 = await fetch(origin + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: regBody });
    assert.equal(r1.status, 201);
    const client = await r1.json();

    const r2 = await fetch(origin + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: regBody });
    assert.equal(r2.status, 429);
    assert.equal(r2.headers.get('access-control-allow-origin'), '*');
    assert.ok(Number(r2.headers.get('retry-after')) >= 1);

    const verifier = secret() + secret();
    const authUrl = origin + '/oauth/authorize?' + new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      response_type: 'code',
      code_challenge: hash(verifier),
      code_challenge_method: 'S256',
      state: 'st-rl',
      resource: origin + '/mcp',
      scope: 'remote:use'
    });
    const html = await (await fetch(authUrl)).text();
    const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)">/g)].map(m => [m[1], m[2]]));
    const postAuth = (password) => fetch(origin + '/oauth/authorize', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...hidden, username: 'admin', password })
    });

    assert.equal((await postAuth('bad1')).status, 403);
    assert.equal((await postAuth('bad2')).status, 403);
    const throttled = await postAuth(admin.password);
    assert.equal(throttled.status, 429);
    assert.ok(Number(throttled.headers.get('retry-after')) >= 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('Store.maintain prunes stale unused DCR clients while keeping active touched clients', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-dcr-prune-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  try {
    const stale = store.registerOAuthClient({
      clientName: 'Stale',
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'client_secret_post',
      scope: 'remote:use'
    });
    const active = store.registerOAuthClient({
      clientName: 'Active',
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'client_secret_post',
      scope: 'remote:use'
    });

    const oldTs = Date.now() - 35 * 86400000;
    store.db.prepare('UPDATE oauth_clients SET created_at=? WHERE client_id IN (?,?)').run(oldTs, stale.clientId, active.clientId);
    store.touchOAuthClient(active.clientId);
    assert.ok(store.findOAuthClient(active.clientId).lastUsedAt >= oldTs);

    store.maintain(7, 90, 30);
    assert.equal(store.findOAuthClient(stale.clientId), null);
    assert.ok(store.findOAuthClient(active.clientId));
  } finally {
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('GoogleAuth /auth/google/activate and DeviceFlow /device/start enforce rate limits', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-rl-endpoints-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const limiter = new RateLimiter({
    rules: {
      google_activate: { max: 1, windowMs: 60_000 },
      device_start: { max: 1, windowMs: 60_000 }
    }
  });
  let googleAuth, deviceFlow;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (await googleAuth.route(req, res, url)) return;
      if (await deviceFlow.route(req, res, url)) return;
      res.writeHead(404).end();
    } catch { res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  googleAuth = new GoogleAuth(store, { origin, clientId: 'cid', clientSecret: 'csec', rateLimiter: limiter });
  deviceFlow = new DeviceFlow(store, origin, limiter);

  try {
    const act1 = await fetch(origin + '/auth/google/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ invite_code: 'abc' })
    });
    assert.equal(act1.status, 400);
    const act2 = await fetch(origin + '/auth/google/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ invite_code: 'def' })
    });
    assert.equal(act2.status, 429);
    assert.ok(Number(act2.headers.get('retry-after')) >= 1);

    const startPayload = JSON.stringify({
      client_id: agentClientId,
      device_name: 'laptop',
      code_challenge: hash(secret()),
      code_challenge_method: 'S256'
    });
    const d1 = await fetch(origin + '/device/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: startPayload });
    assert.equal(d1.status, 200);
    const d2 = await fetch(origin + '/device/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: startPayload });
    assert.equal(d2.status, 429);
    assert.ok(Number(d2.headers.get('retry-after')) >= 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});
