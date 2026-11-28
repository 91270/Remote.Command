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
import { Installer } from '../dist/installer.js';
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

test('OAuth discovery exposes registration_endpoint and DCR completes full authorization flow', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-oauth-dcr-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const created = store.createGoogleUser({
    sub: 'sub-dcr-admin',
    email: 'dcr-admin@example.com',
    displayName: 'DCR Admin',
    avatarUrl: null,
    adminEmails: new Set()
  });
  assert.equal(created.status, 'ok');
  const dashToken = secret();
  store.putAuth(dashToken, 'dashboard', 3600000, {
    csrf: secret(),
    userId: created.user.id,
    username: created.user.email,
    role: created.user.role
  });
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
    const unauthPageRes = await fetch(authMeta.authorization_endpoint + '?' + authQuery.toString());
    assert.equal(unauthPageRes.status, 200);
    assert.match(unauthPageRes.headers.get('content-security-policy'), /form-action 'self' https:\/\/chatgpt\.com/);
    const unauthHtml = await unauthPageRes.text();
    assert.match(unauthHtml, /ChatGPT/);
    assert.match(unauthHtml, /\/auth\/google\/start/);
    assert.doesNotMatch(unauthHtml, /type="password"/);
    assert.doesNotMatch(unauthHtml, /name="password"/);

    const authPageRes = await fetch(authMeta.authorization_endpoint + '?' + authQuery.toString(), {
      headers: { Cookie: `rcm_dashboard=${dashToken}` }
    });
    assert.equal(authPageRes.status, 200);
    const html = await authPageRes.text();
    const hiddenInputs = [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)">/g)];
    const formData = new URLSearchParams();
    for (const [, k, v] of hiddenInputs) formData.set(k, v);
    assert.equal(formData.get('session_auth'), '1');

    const authPostRes = await fetch(authMeta.authorization_endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `rcm_dashboard=${dashToken}`
      },
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

test('Installer serves /install.sh, /install.ps1, /install/remote-windows.cmd and /install/agent.tgz redirect/stream', async () => {
  assert.throws(() => new Installer('https://evil.example/?x=1'), /bare HTTP\(S\) origin/);

  const origin = 'https://mcp.example.com';
  const installer = new Installer(origin);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    if (await installer.route(req, res, url)) return;
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const localBase = 'http://127.0.0.1:' + server.address().port;
  try {
    const shRes = await fetch(localBase + '/install.sh');
    assert.equal(shRes.status, 200);
    const sh = await shRes.text();
    assert.match(sh, /ORIGIN="https:\/\/mcp\.example\.com"/);
    assert.match(sh, /--gateway "\$\{ORIGIN\}" --yes/);
    assert.match(sh, /INSTALL_SERVICE="0"/);
    assert.match(sh, /RCM_INSTALL_SERVICE/);
    assert.match(sh, /--install-service/);

    const shSvcRes = await fetch(localBase + '/install.sh?service=1');
    assert.equal(shSvcRes.status, 200);
    assert.match(await shSvcRes.text(), /INSTALL_SERVICE="1"/);

    const psRes = await fetch(localBase + '/install.ps1');
    assert.equal(psRes.status, 200);
    const ps = await psRes.text();
    assert.match(ps, /\$Origin = 'https:\/\/mcp\.example\.com'/);
    assert.match(ps, /--gateway \$Origin --yes/);
    assert.match(ps, /\$InstallService = \$false/);
    assert.match(ps, /\$CreateShortcut = \$false/);
    assert.match(ps, /RCM_INSTALL_SERVICE/);
    assert.match(ps, /RCM_DESKTOP_SHORTCUT/);
    assert.match(ps, /--install-service/);

    const psSvcRes = await fetch(localBase + '/install.ps1?service=1&shortcut=1');
    assert.equal(psSvcRes.status, 200);
    const psSvc = await psSvcRes.text();
    assert.match(psSvc, /\$InstallService = \$true/);
    assert.match(psSvc, /\$CreateShortcut = \$true/);
    assert.match(psSvc, /Ensure-DesktopShortcut/);
    assert.match(psSvc, /launch-agent\.cmd/);
    assert.match(psSvc, /WScript\.Shell/);

    const cmdRes = await fetch(localBase + '/install/remote-windows.cmd');
    assert.equal(cmdRes.status, 200);
    assert.equal(cmdRes.headers.get('content-disposition'), 'attachment; filename="remote-windows.cmd"');
    assert.equal(cmdRes.headers.get('cache-control'), 'no-store');
    assert.equal(cmdRes.headers.get('x-content-type-options'), 'nosniff');
    const cmd = await cmdRes.text();
    assert.equal(cmd.includes('\r\n'), true);
    assert.equal(/(?<!\r)\n/.test(cmd), false, 'Batch launcher must use strict CRLF line endings');
    assert.equal(cmd.includes('set "RCM_SCRIPT_URL=https://mcp.example.com/install.ps1?shortcut=1"'), true);
    assert.match(cmd, /powershell\.exe -NoProfile -ExecutionPolicy Bypass/);
    assert.match(cmd, /\$env:RCM_SCRIPT_URL/);

    const cmdSvcRes = await fetch(localBase + '/install/remote-windows.cmd?service=1');
    assert.equal(cmdSvcRes.status, 200);
    const cmdSvc = await cmdSvcRes.text();
    assert.equal(cmdSvc.includes('set "RCM_SCRIPT_URL=https://mcp.example.com/install.ps1?service=1&shortcut=1"'), true);

    const cmdNoShortcutRes = await fetch(localBase + '/install/remote-windows.cmd?shortcut=0');
    assert.equal(cmdNoShortcutRes.status, 200);
    const cmdNoShortcut = await cmdNoShortcutRes.text();
    assert.equal(cmdNoShortcut.includes('set "RCM_SCRIPT_URL=https://mcp.example.com/install.ps1"'), true);

    const tgzRes = await fetch(localBase + '/install/agent.tgz', { redirect: 'manual' });
    assert.ok(tgzRes.status === 200 || tgzRes.status === 302);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('OAuth refresh_token preserves selectedDevice across rotations and drops it if device is revoked', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-oauth-selected-device-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  const created = store.createGoogleUser({
    sub: 'sub-refresh-admin',
    email: 'refresh-admin@example.com',
    displayName: 'Refresh Admin',
    avatarUrl: null,
    adminEmails: new Set()
  });
  assert.equal(created.status, 'ok');
  const admin = created.user;
  const dashToken = secret();
  store.putAuth(dashToken, 'dashboard', 3600000, {
    csrf: secret(),
    userId: admin.id,
    username: admin.email,
    role: admin.role
  });
  const dev = store.pair(store.invite('workstation', ['read'], admin.id), secret());
  assert.ok(dev);
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
  oauth = new OAuth(store, { origin, ownerKey: secret() });

  try {
    const reg = await (await fetch(origin + '/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT',
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect']
      })
    })).json();

    const verifier = secret() + secret();
    const authUrl = origin + '/oauth/authorize?' + new URLSearchParams({
      client_id: reg.client_id,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      response_type: 'code',
      code_challenge: hash(verifier),
      code_challenge_method: 'S256',
      state: 'st-refresh',
      resource: origin + '/mcp',
      scope: 'remote:use'
    });
    const pageHtml = await (await fetch(authUrl, {
      headers: { Cookie: `rcm_dashboard=${dashToken}` }
    })).text();
    const hidden = Object.fromEntries([...pageHtml.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)">/g)].map(m => [m[1], m[2]]));
    assert.equal(hidden.session_auth, '1');
    const consentRes = await fetch(origin + '/oauth/authorize', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `rcm_dashboard=${dashToken}`
      },
      body: new URLSearchParams(hidden)
    });
    assert.equal(consentRes.status, 303);
    const code = new URL(consentRes.headers.get('location')).searchParams.get('code');

    const initialTokens = await (await fetch(origin + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: reg.client_id,
        client_secret: reg.client_secret,
        redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        code_verifier: verifier,
        resource: origin + '/mcp'
      })
    })).json();
    assert.ok(initialTokens.access_token && initialTokens.refresh_token);

    // Select device on the initial access token
    assert.equal(store.setOAuthSelectedDevice(initialTokens.access_token, dev.id), true);

    // First refresh rotation
    const refresh1 = await (await fetch(origin + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: initialTokens.refresh_token,
        client_id: reg.client_id,
        client_secret: reg.client_secret,
        resource: origin + '/mcp'
      })
    })).json();
    assert.ok(refresh1.access_token && refresh1.refresh_token);
    assert.equal(store.getAuth(refresh1.access_token, 'access').data.selectedDevice, dev.id);

    // Second refresh rotation still preserves selectedDevice
    const refresh2 = await (await fetch(origin + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh1.refresh_token,
        client_id: reg.client_id,
        client_secret: reg.client_secret,
        resource: origin + '/mcp'
      })
    })).json();
    assert.equal(store.getAuth(refresh2.access_token, 'access').data.selectedDevice, dev.id);

    // Revoking the device drops stale selectedDevice on subsequent refresh
    assert.equal(store.revoke(dev.id, admin.id), true);
    const refresh3 = await (await fetch(origin + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh2.refresh_token,
        client_id: reg.client_id,
        client_secret: reg.client_secret,
        resource: origin + '/mcp'
      })
    })).json();
    assert.equal(store.getAuth(refresh3.access_token, 'access').data.selectedDevice, undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});
