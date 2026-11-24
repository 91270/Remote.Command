import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Store } from '../dist/store.js';
import { GoogleAuth } from '../dist/google-auth.js';
import { Dashboard } from '../dist/dashboard.js';
import { OAuth } from '../dist/oauth.js';
import { hash, secret } from '../dist/protocol.js';

function startMockGoogleOidc() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'mock-kid-1', alg: 'RS256', use: 'sig' };
  let nextProfile = { sub: 'google-sub-1', email: 'first@example.com', name: 'First User', picture: 'https://example.com/a.png', email_verified: true };
  let lastAuthParams = null;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    if (url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: origin + '/authorize',
        token_endpoint: origin + '/token',
        jwks_uri: origin + '/jwks'
      }));
      return;
    }
    if (url.pathname === '/jwks') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const params = new URLSearchParams(Buffer.concat(chunks).toString());
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.ok(lastAuthParams);
      assert.equal(hash(params.get('code_verifier')), lastAuthParams.get('code_challenge'));
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'mock-kid-1' })).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(JSON.stringify({
        iss: origin,
        aud: params.get('client_id'),
        sub: nextProfile.sub,
        email: nextProfile.email,
        email_verified: nextProfile.email_verified,
        name: nextProfile.name,
        picture: nextProfile.picture,
        nonce: lastAuthParams.get('nonce'),
        iat: now,
        exp: now + 3600
      })).toString('base64url');
      const sig = cryptoSign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id_token: `${header}.${payload}.${sig}` }));
      return;
    }
    res.writeHead(404).end();
  });

  let origin = '';
  return {
    async listen() {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      origin = 'http://127.0.0.1:' + server.address().port;
      return origin;
    },
    setProfile(p) { nextProfile = { email_verified: true, picture: 'https://example.com/u.png', ...p }; },
    captureAuthUrl(rawUrl) { lastAuthParams = new URL(rawUrl).searchParams; },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function extractCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const map = new Map();
  for (const item of raw) {
    const pair = item.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return map;
}

test('Gateway refuses to start with clear error log when GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-google-required-'));
  try {
    const env = {
      ...process.env,
      STATE_DB: join(temp, 'gateway.sqlite'),
      PUBLIC_ORIGIN: 'http://127.0.0.1:18787',
      ALLOW_INSECURE_LOOPBACK: '1',
      PORT: '18787',
      BIND_HOST: '127.0.0.1'
    };
    delete env.GOOGLE_CLIENT_ID;
    delete env.GOOGLE_CLIENT_SECRET;
    const proc = spawn(process.execPath, ['dist/gateway.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.setEncoding('utf8').on('data', d => { output += d; });
    proc.stderr.setEncoding('utf8').on('data', d => { output += d; });
    const [code] = await once(proc, 'exit');
    assert.notEqual(code, 0);
    assert.match(output, /GOOGLE_CLIENT_ID/);
    assert.match(output, /GOOGLE_CLIENT_SECRET/);
    assert.match(output, /\/auth\/google\/callback/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('Google OIDC: first user becomes admin, invite_only/open/closed modes, and one-click OAuth consent', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-google-oidc-'));
  const mockGoogle = startMockGoogleOidc();
  const mockOrigin = await mockGoogle.listen();
  const store = new Store(join(temp, 'gateway.sqlite'));
  let googleAuth, dashboard, oauth;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (await googleAuth.route(req, res, url)) return;
      if (await dashboard.route(req, res, url)) return;
      if (await oauth.route(req, res, url)) return;
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;

  googleAuth = new GoogleAuth(store, {
    origin,
    clientId: 'test-google-cid',
    clientSecret: 'test-google-secret',
    discoveryUrl: mockOrigin + '/.well-known/openid-configuration'
  });
  dashboard = new Dashboard(store, { origin, googleEnabled: true });
  oauth = new OAuth(store, { origin, ownerKey: secret(), googleEnabled: true });

  async function doGoogleLogin(profile, returnTo = '/manage') {
    mockGoogle.setProfile(profile);
    const startRes = await fetch(origin + '/auth/google/start?return_to=' + encodeURIComponent(returnTo), { redirect: 'manual' });
    assert.equal(startRes.status, 302);
    const authUrl = startRes.headers.get('location');
    mockGoogle.captureAuthUrl(authUrl);
    const oidcCookies = extractCookies(startRes);
    const state = new URL(authUrl).searchParams.get('state');
    const cbRes = await fetch(origin + `/auth/google/callback?code=mock-code&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { Cookie: `rcm_oidc=${oidcCookies.get('rcm_oidc')}` }
    });
    return cbRes;
  }

  try {
    // 1. First Google user becomes admin (plan=pro) even under default invite_only mode
    const firstRes = await doGoogleLogin({ sub: 'sub-admin', email: 'owner@example.com', name: 'Owner' });
    assert.equal(firstRes.status, 303);
    assert.equal(firstRes.headers.get('location'), '/manage');
    const adminCookie = extractCookies(firstRes).get('rcm_dashboard');
    assert.ok(adminCookie);
    const adminSession = await (await fetch(origin + '/manage/api/session', { headers: { Cookie: `rcm_dashboard=${adminCookie}` } })).json();
    assert.equal(adminSession.role, 'admin');
    assert.equal(adminSession.plan, 'pro');
    assert.equal(adminSession.email, 'owner@example.com');

    // 2. Second user under invite_only gets activation form -> invalid invite rejected -> valid invite activates
    const secondRes = await doGoogleLogin({ sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' });
    assert.equal(secondRes.status, 200);
    const pendingCookie = extractCookies(secondRes).get('rcm_google_pending');
    assert.ok(pendingCookie);

    const badAct = await fetch(origin + '/auth/google/activate', {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: `rcm_google_pending=${pendingCookie}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ invite_code: 'INVALID-CODE' })
    });
    assert.equal(badAct.status, 400);

    const invite = store.createRegistrationInvite(adminSession.userId, { maxUses: 1 });
    const goodAct = await fetch(origin + '/auth/google/activate', {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: `rcm_google_pending=${pendingCookie}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ invite_code: invite.code })
    });
    assert.equal(goodAct.status, 303);
    const bobCookie = extractCookies(goodAct).get('rcm_dashboard');
    assert.ok(bobCookie);
    const bobSession = await (await fetch(origin + '/manage/api/session', { headers: { Cookie: `rcm_dashboard=${bobCookie}` } })).json();
    assert.equal(bobSession.role, 'user');
    assert.equal(bobSession.plan, 'free');
    assert.equal(bobSession.email, 'bob@example.com');

    // 3. Open registration mode allows direct signup without invite code
    store.setRegistrationMode('open', adminSession.userId);
    const thirdRes = await doGoogleLogin({ sub: 'sub-carol', email: 'carol@example.com', name: 'Carol' });
    assert.equal(thirdRes.status, 303);
    const carolCookie = extractCookies(thirdRes).get('rcm_dashboard');
    const carolSession = await (await fetch(origin + '/manage/api/session', { headers: { Cookie: `rcm_dashboard=${carolCookie}` } })).json();
    assert.equal(carolSession.email, 'carol@example.com');

    // 4. Closed registration mode blocks new users, still allows existing Bob to sign in
    store.setRegistrationMode('closed', adminSession.userId);
    const blockedRes = await doGoogleLogin({ sub: 'sub-dave', email: 'dave@example.com', name: 'Dave' });
    assert.equal(blockedRes.status, 403);
    const bobAgain = await doGoogleLogin({ sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' });
    assert.equal(bobAgain.status, 303);

    // 5. One-click ChatGPT OAuth consent reuses Bob's Google session cookie
    const reg = await (await fetch(origin + '/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] })
    })).json();
    const verifier = secret() + secret();
    const authParams = new URLSearchParams({
      client_id: reg.client_id,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      response_type: 'code',
      code_challenge: hash(verifier),
      code_challenge_method: 'S256',
      state: 'st-bob',
      resource: origin + '/mcp',
      scope: 'remote:use'
    });
    const consentHtml = await (await fetch(origin + '/oauth/authorize?' + authParams, {
      headers: { Cookie: `rcm_dashboard=${bobCookie}` }
    })).text();
    assert.match(consentHtml, /bob@example\.com/);
    assert.match(consentHtml, /name="session_auth" value="1"/);
    const hidden = Object.fromEntries([...consentHtml.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)">/g)].map(m => [m[1], m[2]]));
    const approved = await fetch(origin + '/oauth/authorize', {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: `rcm_dashboard=${bobCookie}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(hidden)
    });
    assert.equal(approved.status, 303);
    const authCode = new URL(approved.headers.get('location')).searchParams.get('code');
    const tokens = await (await fetch(origin + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        client_id: reg.client_id,
        client_secret: reg.client_secret,
        redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        code_verifier: verifier,
        resource: origin + '/mcp'
      })
    })).json();
    assert.ok(tokens.access_token);
    const storedAccess = store.getAuth(tokens.access_token, 'access');
    assert.equal(storedAccess.data.userId, bobSession.userId);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await mockGoogle.close();
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('ADMIN_GOOGLE_EMAILS restricts first admin claim on fresh deployment', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-google-admin-lock-'));
  const store = new Store(join(temp, 'gateway.sqlite'));
  try {
    const adminEmails = new Set(['boss@example.com']);
    const denied = store.createGoogleUser({ sub: 'sub-stranger', email: 'stranger@example.com', displayName: null, avatarUrl: null, adminEmails });
    assert.equal(denied.status, 'admin_email_required');
    assert.equal(store.userCount(), 0);

    const allowed = store.createGoogleUser({ sub: 'sub-boss', email: 'boss@example.com', displayName: 'Boss', avatarUrl: null, adminEmails });
    assert.equal(allowed.status, 'ok');
    assert.equal(allowed.isFirstAdmin, true);
    assert.equal(allowed.user.role, 'admin');
    assert.equal(allowed.user.plan, 'pro');
  } finally {
    store.db.close();
    await rm(temp, { recursive: true, force: true });
  }
});
