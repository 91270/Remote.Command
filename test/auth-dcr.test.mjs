import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { RotatingLogger } from '../dist/logger.js';
import { Store } from '../dist/store.js';
import { OAuth } from '../dist/oauth.js';
import { hash, secret } from '../dist/protocol.js';

test('RotatingLogger splits log files by size using YYYYMMDD-HHmm.log format', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-logger-'));
  try {
    const logger = new RotatingLogger({ dir: temp, maxBytes: 1024, maxFiles: 2 });
    for (let i = 0; i < 40; i++) {
      logger.info(`line-${i}-${'x'.repeat(80)}`);
    }
    const files = (await readdir(temp)).sort();
    assert.ok(files.length >= 1 && files.length <= 2, `unexpected log files: ${files.join(', ')}`);
    for (const file of files) {
      assert.match(file, /^\d{8}-\d{4}\.log$/);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('Store creates initial admin once with 8-char password and authenticates it', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-admin-init-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  try {
    const first = store.ensureInitialAdmin();
    assert.ok(first);
    assert.equal(first.username, 'admin');
    assert.equal(first.password.length, 8);
    assert.match(first.password, /^[A-Za-z0-9]{8}$/);

    const second = store.ensureInitialAdmin();
    assert.equal(second, null);

    const ok = store.authenticateUser('admin', first.password);
    assert.ok(ok);
    assert.equal(ok.username, 'admin');
    assert.equal(ok.role, 'admin');

    assert.equal(store.authenticateUser('admin', 'wrongpwd'), null);
    assert.equal(store.authenticateUser('other', first.password), null);
  } finally {
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('OAuth discovery exposes registration_endpoint and DCR completes full authorization flow', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-oauth-dcr-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const admin = store.ensureInitialAdmin();
  assert.ok(admin);
  const ownerKey = secret();
  let oauth;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (await oauth.route(req, res, url)) return;
      res.writeHead(404).end();
    } catch {
      res.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  oauth = new OAuth(store, { origin, ownerKey });

  try {
    const protectedRes = await fetch(origin + '/.well-known/oauth-protected-resource/mcp');
    assert.equal(protectedRes.status, 200);
    const protectedMeta = await protectedRes.json();
    assert.equal(protectedMeta.resource, origin + '/mcp');
    assert.deepEqual(protectedMeta.authorization_servers, [origin]);

    const authServerRes = await fetch(origin + '/.well-known/oauth-authorization-server');
    assert.equal(authServerRes.status, 200);
    const authMeta = await authServerRes.json();
    assert.equal(authMeta.registration_endpoint, origin + '/oauth/register');
    assert.equal(authMeta.authorization_endpoint, origin + '/oauth/authorize');
    assert.equal(authMeta.token_endpoint, origin + '/oauth/token');

    const blockedReg = await fetch(authMeta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.example/callback'] })
    });
    assert.equal(blockedReg.status, 400);

    const regRes = await fetch(authMeta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect']
      })
    });
    assert.equal(regRes.status, 201);
    const reg = await regRes.json();
    assert.ok(reg.client_id.startsWith('rcm_'));
    assert.equal(reg.client_secret.length, 43);

    const verifier = secret() + secret();
    const challenge = hash(verifier);
    const authQuery = new URLSearchParams({
      client_id: reg.client_id,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'state-123',
      resource: origin + '/mcp',
      scope: 'remote:use'
    });
    const authPageRes = await fetch(authMeta.authorization_endpoint + '?' + authQuery.toString());
    assert.equal(authPageRes.status, 200);
    assert.match(authPageRes.headers.get('content-security-policy'), /form-action 'self' https:\/\/chatgpt\.com/);
    const html = await authPageRes.text();
    assert.match(html, /ChatGPT/);
    assert.match(html, /name="username"/);
    assert.match(html, /name="password"/);

    const hiddenInputs = [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)">/g)];
    const formData = new URLSearchParams();
    for (const [, k, v] of hiddenInputs) formData.set(k, v);
    formData.set('username', 'admin');
    formData.set('password', admin.password);

    const authPostRes = await fetch(authMeta.authorization_endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData
    });
    assert.equal(authPostRes.status, 303);
    const location = new URL(authPostRes.headers.get('location'));
    const code = location.searchParams.get('code');
    assert.ok(code);
    assert.equal(location.searchParams.get('state'), 'state-123');

    const tokenRes = await fetch(authMeta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        client_id: reg.client_id,
        client_secret: reg.client_secret,
        code_verifier: verifier,
        resource: origin + '/mcp'
      })
    });
    assert.equal(tokenRes.status, 200);
    const tokens = await tokenRes.json();
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('OAuth DCR allows loopback redirect_uris from Codex/CLI even when Gateway origin is HTTPS', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-oauth-loopback-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const oauth = new OAuth(store, { origin: 'https://mcp.example.com', ownerKey: secret() });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'https://mcp.example.com');
    if (await oauth.route(req, res, url)) return;
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const localBase = 'http://127.0.0.1:' + server.address().port;
  try {
    const res = await fetch(localBase + '/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Codex CLI',
        redirect_uris: ['http://127.0.0.1:43210/callback', 'http://localhost:43211/callback']
      })
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.client_name, 'Codex CLI');
    assert.deepEqual(data.redirect_uris, ['http://127.0.0.1:43210/callback', 'http://localhost:43211/callback']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});
