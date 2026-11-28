import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readdir, rm, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { secret, hash } from '../dist/protocol.js';
import { Store } from '../dist/store.js';

const packedCli = process.env.RCM_TEST_PACKED_CLI;

async function until(fn, ms = 25000) {
  const end = Date.now() + ms;
  let error;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (e) { error = e; }
    await delay(140);
  }
  throw new Error('Timed out waiting for condition', { cause: error });
}
async function port() {
  const s = createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = s.address().port;
  await new Promise(ok => s.close(ok));
  return p;
}
function start(args, options = {}, executable = process.execPath) {
  const p = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const pipe of [p.stdout, p.stderr]) pipe.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-10000); });
  p.output = () => output;
  return p;
}
async function agentTerminal(args, input, env, cwd) {
  // Python's pty gives the CLI a real terminal on macOS/Linux. Input is
  // supplied on a pipe; fixture secrets do not appear in argv or test output.
  const harness = String.raw`
import errno, os, pty, select, subprocess, sys, time
answer = sys.stdin.buffer.readline()
master, slave = pty.openpty()
cli = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
try:
    output, sent, deadline = b'', False, time.monotonic() + 9
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.2)[0]:
            if cli.poll() is not None:
                break
            continue
        try:
            block = os.read(master, 8192)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not block:
            break
        output += block
        if not sent and (b"pairing token:" in output or b"exact request:" in output):
            os.write(master, answer)
            sent = True
    cli.wait(timeout=1)
    if cli.returncode != 0 or not sent or not (b"Paired device:" in output or b"Decision recorded." in output):
        sys.stderr.buffer.write(output.replace(answer.strip(), b"[fixture secret]")[-1500:])
        sys.exit(1)
finally:
    if cli.poll() is None:
        cli.kill()
        cli.wait()
    os.close(master)
`;
  const entry = packedCli ? [packedCli, 'agent'] : [resolve('dist/agent.js')];
  const p = spawn('python3', ['-c', harness, process.execPath, ...entry, ...args], { cwd, env, stdio: ['pipe', 'ignore', 'pipe'] });
  let output = '';
  p.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  p.stdin.end(input + '\n');
  const [code] = await once(p, 'close');
  assert.equal(code, 0, 'Local CLI pairing/confirmation failed. ' + output);
}
async function stop(p) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  const ended = once(p, 'exit');
  const deadline = setTimeout(() => p.kill('SIGKILL'), 9000);
  p.kill('SIGTERM');
  try { await ended; } finally { clearTimeout(deadline); }
}
const form = (origin, path, fields, headers = {}) => fetch(origin + path, { method: 'POST', redirect: 'manual', headers,
  body: new URLSearchParams(fields) });
const jwt = token => ({ Authorization: 'Bearer ' + token });
const post = (url, data, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });

test('Gateway initializes private credentials once and reuses them after restart', { timeout: 20000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-gateway-credentials-'));
  let gateway;
  try {
    const p = await port();
    const origin = `http://127.0.0.1:${p}`;
    const state = join(temp, 'data');
    const clientFile = join(state, '.oauth_client_secret');
    const ownerFile = join(state, '.owner_key');
    const env = { ...process.env, STATE_DB: join(state, 'gateway.sqlite'), PUBLIC_ORIGIN: origin,
      ALLOW_INSECURE_LOOPBACK: '1', PORT: String(p), BIND_HOST: '127.0.0.1', OAUTH_CLIENT_ID: 'fixture_client',
      OAUTH_REDIRECT_URIS: 'http://127.0.0.1:9990/callback',
      GOOGLE_CLIENT_ID: 'fixture-google-client', GOOGLE_CLIENT_SECRET: 'fixture-google-secret' };
    for (const name of ['OAUTH_CLIENT_SECRET', 'OAUTH_CLIENT_SECRET_FILE', 'OWNER_KEY', 'OWNER_KEY_FILE']) delete env[name];

    const boot = async () => {
      gateway = start(['dist/gateway.js'], { env });
      const ready = await until(async () => gateway.exitCode !== null ? 'exited' : (await fetch(origin + '/readyz')).ok);
      assert.equal(ready, true, gateway.output());
    };
    await boot();
    const clientSecret = (await readFile(clientFile, 'utf8')).trim();
    const ownerKey = (await readFile(ownerFile, 'utf8')).trim();
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(clientSecret));
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(ownerKey));
    assert.ok(clientSecret !== ownerKey);
    if (process.platform !== 'win32') {
      assert.equal((await stat(clientFile)).mode & 0o777, 0o600);
      assert.equal((await stat(ownerFile)).mode & 0o777, 0o600);
    }
    assert.ok(!gateway.output().includes(clientSecret) && !gateway.output().includes(ownerKey));
    assert.match(gateway.output(), /awaiting first admin sign-in via Google OAuth/);
    const logDir = join(state, 'logs');
    const logFiles = (await readdir(logDir)).filter(name => /^\d{8}-\d{4}\.log$/.test(name));
    assert.ok(logFiles.length >= 1);
    const logContent = await readFile(join(logDir, logFiles.at(-1)), 'utf8');
    assert.match(logContent, /awaiting first admin sign-in via Google OAuth/);

    await stop(gateway);
    await boot();
    assert.ok((await readFile(clientFile, 'utf8')).trim() === clientSecret);
    assert.ok((await readFile(ownerFile, 'utf8')).trim() === ownerKey);
    const authCfg = await (await fetch(origin + '/manage/api/auth-config')).json();
    assert.equal(authCfg.googleEnabled, true);
    assert.equal(authCfg.initialized, false);
  } finally {
    await stop(gateway);
    await rm(temp, { recursive: true, force: true });
  }
});

test('OAuth + Streamable HTTP + Gateway + Agent + native tools, including reconnect and cancellation', { timeout: 180000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-e2e-'));
  const ws = join(temp, 'workspace'), stateDir = join(temp, 'private'), config = join(temp, 'agent.json');
  const db = join(temp, 'gateway.sqlite'), p = await port(), agentPort = process.env.RCM_TEST_TLS === '1' ? await port() : p;
  const backend = 'http://127.0.0.1:' + p;
  let origin = backend, agentOrigin = backend, proxy, testCert;
  const originalFetch = globalThis.fetch;
  // Optional HTTPS boundary: generate an ephemeral certificate; the Agent
  // verifies it through NODE_EXTRA_CA_CERTS on a real TLS connection.
  if (agentPort !== p) {
    origin = agentOrigin = 'https://127.0.0.1:' + agentPort;
    testCert = join(temp, 'test.crt');
    const key = join(temp, 'test.key');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-out', testCert, '-keyout', key], { stdio: 'ignore' });
    proxy = httpsServer({ key: await readFile(key), cert: await readFile(testCert) }, (req, res) => {
      const upstream = httpRequest(backend + req.url, { method: req.method, headers: req.headers }, r => {
        res.writeHead(r.statusCode, r.headers); r.pipe(res);
      });
      upstream.on('error', () => res.writeHead(503).end());
      req.pipe(upstream);
    }).listen(agentPort, '127.0.0.1');
    await once(proxy, 'listening');
    const ca = await readFile(testCert);
    // The MCP test client trusts only this ephemeral CA. The independently
    // spawned Agent gets the same CA through NODE_EXTRA_CA_CERTS.
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== origin) return originalFetch(input, init);
      const bytes = Buffer.from(await request.arrayBuffer());
      return new Promise((resolve, reject) => {
        const connection = httpsRequest(request.url, {
          method: request.method, headers: Object.fromEntries(request.headers), ca, signal: request.signal
        }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
              else if (value !== undefined) headers.set(key, value);
            }
            const status = response.statusCode;
            resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
          });
          response.on('error', reject);
        });
        connection.on('error', reject);
        connection.end(bytes);
      });
    };
  }
  const resource = origin + '/mcp';
  const clientId = 'fixture_client', clientSecret = secret(), owner = secret();
  const redirect = (proxy ? 'https:' : 'http:') + '//127.0.0.1:9990/callback';
  const env = { ...process.env, STATE_DB: db, PUBLIC_ORIGIN: origin, ALLOW_INSECURE_LOOPBACK: '1', PORT: String(p),
    BIND_HOST: '127.0.0.1', OAUTH_CLIENT_ID: clientId, OAUTH_CLIENT_SECRET: clientSecret, OWNER_KEY: owner, OAUTH_REDIRECT_URIS: redirect,
    GOOGLE_CLIENT_ID: 'fixture-google-client', GOOGLE_CLIENT_SECRET: 'fixture-google-secret' };
  const oauthSecretFile = join(temp, 'oauth-secret');
  const ownerKeyFile = join(temp, 'owner-key');
  const fileEnv = { ...env, OAUTH_CLIENT_SECRET: secret(), OWNER_KEY: secret(),
    OAUTH_CLIENT_SECRET_FILE: oauthSecretFile, OWNER_KEY_FILE: ownerKeyFile };
  const agentEnv = { ...env, ...(testCert && { NODE_EXTRA_CA_CERTS: testCert }) };
  const startAgent = (action, ...flags) => {
    if (!packedCli) return start(['dist/agent.js', action, config, ...flags], { env: agentEnv });
    const args = action === 'run' ? ['agent', action, config] : ['remote', '--config', config, ...flags];
    if (action === 'report') args.push('--report');
    if (action === 'logout') args.push('--logout');
    return start([packedCli, ...args], { cwd: temp, env: agentEnv });
  };
  const tty = process.env.RCM_TEST_TTY === '1' && process.platform !== 'win32';
  let gateway, agent, client;
  const startGateway = async (secrets = fileEnv) => {
    gateway = start(['dist/gateway.js'], { env: secrets });
    await until(async () => (await fetch(origin + '/healthz')).ok);
  };
  const stdout = () => `Gateway: ${gateway?.output()}\nAgent: ${agent?.output()}`;
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const payload = response => JSON.parse(response.content[0].text);
  const tool = async (name, args = {}) => payload(await call(name, args));
  const getResult = id => call('get_tool_result', { call_id: id });
  const callStatus = async id => {
    const response = await getResult(id);
    let value;
    try { value = payload(response); } catch { /* native tool text */ }
    return value?.call_id === id ? value : { status: response.isError ? 'failed' : 'succeeded', response };
  };
  const complete = (id, wanted) => until(async () => {
    const value = await callStatus(id);
    const settled = ['succeeded', 'failed', 'cancelled', 'timed_out', 'denied', 'interrupted'].includes(value.status);
    return (wanted ? value.status === wanted : settled) && value;
  });
  const permission = async (task, decision) => {
    const file = join(stateDir, 'approvals', task + '.pending.json');
    const data = await until(() => readFile(file, 'utf8'));
    assert.equal(JSON.parse(data).job.id, task);
    if (tty) await agentTerminal(['decide', config, task, decision], decision, agentEnv, packedCli ? temp : undefined);
    else await writeFile(join(stateDir, 'approvals', task + '.decision.json'), JSON.stringify({ decision, digest: hash(data) }), { flag: 'wx', mode: 0o600 });
    return JSON.parse(data);
  };
  try {
    await mkdir(ws);
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(join(ws, 'hello.txt'), 'there is a needle\r\nsecond line\r\n');
    await writeFile(oauthSecretFile, clientSecret + '\n');
    await writeFile(ownerKeyFile, owner + '\n');
    await writeFile(config, JSON.stringify({ gateway: agentOrigin, workspace: ws, stateDir, allowInsecureLoopback: !proxy }));
    const seedStore = new Store(db);
    const createdOwner = seedStore.createGoogleUser({
      sub: 'e2e-owner-sub',
      email: 'owner@example.com',
      displayName: 'Owner',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(createdOwner.status, 'ok');
    const dashToken = secret();
    const dashCsrf = secret();
    seedStore.putAuth(dashToken, 'dashboard', 3600000, {
      csrf: dashCsrf,
      userId: createdOwner.user.id,
      username: createdOwner.user.email,
      role: createdOwner.user.role
    });
    seedStore.db.close();
    const dashCookieName = origin.startsWith('https:') ? '__Host-rcm_dashboard' : 'rcm_dashboard';
    const dashCookie = `${dashCookieName}=${dashToken}`;
    await startGateway();
    assert.equal((await fetch(resource)).status, 401);
    assert.equal((await fetch(resource, { headers: { Origin: 'https://invalid.example' } })).status, 403);
    const meta = await (await fetch(origin + '/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(meta.resource, resource);
    const issuer = await (await fetch(origin + '/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(issuer.code_challenge_methods_supported, ['S256']);
    const verifier = secret();
    const authParams = { client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: hash(verifier),
      code_challenge_method: 'S256', state: 'client-state', resource, scope: 'remote:use' };
    assert.equal((await fetch(issuer.authorization_endpoint + '?' + new URLSearchParams({ ...authParams, redirect_uri: 'https://invalid.example' }))).status, 400);
    const unauthPage = await (await fetch(issuer.authorization_endpoint + '?' + new URLSearchParams(authParams))).text();
    assert.match(unauthPage, /\/auth\/google\/start/);
    assert.doesNotMatch(unauthPage, /type="password"/);
    const authorizationPage = await fetch(issuer.authorization_endpoint + '?' + new URLSearchParams(authParams), {
      headers: { Cookie: dashCookie }
    });
    assert.equal(authorizationPage.status, 200);
    assert.equal(authorizationPage.headers.get('referrer-policy'), 'strict-origin',
      'The consent page must preserve the Origin header on same-origin browser form submissions.');
    const page = await authorizationPage.text();
    const base = { ...authParams, until: /name="until" value="([^"]+)"/.exec(page)[1], proof: /name="proof" value="([^"]+)"/.exec(page)[1] };
    const opaqueOrigin = await form(origin, '/oauth/authorize', { ...base, session_auth: '1' }, { Origin: 'null', Cookie: dashCookie });
    assert.equal(opaqueOrigin.status, 403);
    assert.deepEqual(await opaqueOrigin.json(), { error: 'Origin not allowed.' });
    const unauthSubmit = await form(origin, '/oauth/authorize', { ...base, session_auth: '1' }, { Origin: origin });
    assert.equal(unauthSubmit.status, 403);
    assert.deepEqual(await unauthSubmit.json(), { error: 'access_denied' });
    const authorized = await form(origin, '/oauth/authorize', { ...base, session_auth: '1' }, { Origin: origin, Cookie: dashCookie });
    assert.equal(authorized.status, 303);
    assert.equal(authorized.headers.get('referrer-policy'), 'no-referrer');
    const callback = new URL(authorized.headers.get('location'));
    assert.equal(callback.searchParams.get('state'), 'client-state');
    assert.equal(callback.searchParams.get('iss'), origin);
    const grant = { grant_type: 'authorization_code', code: callback.searchParams.get('code'), code_verifier: verifier,
      resource, redirect_uri: redirect };
    const basic = { Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64') };
    assert.equal((await form(origin, '/oauth/token', { ...grant, code_verifier: secret() }, basic)).status, 400);
    assert.equal((await form(origin, '/oauth/token', { ...grant, resource: origin + '/another' }, basic)).status, 400);
    const exchanged = await form(origin, '/oauth/token', grant, basic);
    assert.equal(exchanged.status, 200);
    const tokens = await exchanged.json();
    assert.equal((await form(origin, '/oauth/token', grant, basic)).status, 400);
    const refresh = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource, client_id: clientId, client_secret: clientSecret };
    assert.equal((await form(origin, '/oauth/token', refresh)).status, 200);
    assert.equal((await form(origin, '/oauth/token', refresh)).status, 400);
    client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: jwt(tokens.access_token) } }));
    const list = await client.listTools();
    const catalog = JSON.parse(await readFile('vendor/desktop-commander-full/catalog.json', 'utf8'));
    assert.deepEqual(new Set(list.tools.map(tool => tool.name)), new Set([
      'shutdown', 'list_devices', 'select_device', 'who_am_i', 'get_tool_result', 'cancel_tool_call', 'list_remote_tool_calls', 'review_device_call',
      ...catalog.tools.map(tool => tool.name)
    ]));
    assert.equal(client.getServerVersion().name, 'remote-command');
    assert.equal(client.getServerVersion().version, JSON.parse(await readFile('package.json', 'utf8')).version);
    const instructions = client.getInstructions() ?? '';
    for (const keyword of ['list_devices', 'select_device', 'get_tool_result', 'awaiting_approval', 'review_device_call', 'untrusted data']) {
      assert.equal(instructions.includes(keyword), true, `Missing instruction keyword: ${keyword}`);
    }
    const reviewTool = list.tools.find(tool => tool.name === 'review_device_call');
    assert.equal(reviewTool._meta.ui.resourceUri, 'ui://remote-command/call-review.html');
    const reviewUI = await client.readResource({ uri: reviewTool._meta.ui.resourceUri });
    const pkgVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
    assert.match(reviewUI.contents[0].text, /ui\/notifications\/tool-result/);
    assert.equal(reviewUI.contents[0].text.includes(JSON.stringify(pkgVersion)), true);
    assert.equal(reviewUI.contents[0].text.includes('0.4.1'), false);
    const input = { tool_name: 'write_file', arguments: { path: 'preview-only.txt', content: 'never queued' }, summary: 'Inspect the proposed write.' };
    const proposed = await client.callTool({ name: 'review_device_call', arguments: input });
    assert.deepEqual(proposed.structuredContent.arguments, input.arguments);
    assert.equal(proposed.structuredContent.after_client_error, false);
    assert.equal(proposed.structuredContent.block_source, 'none');
    const blocked = await client.callTool({ name: 'review_device_call', arguments: { ...input, client_error: 'Blocked', likely_reason: 'Host validation declined the call.' } });
    assert.equal(blocked.structuredContent.after_client_error, true);
    assert.equal(blocked.structuredContent.block_source, 'host_safety');
    assert.ok(Array.isArray(blocked.structuredContent.guidance) && blocked.structuredContent.guidance.length > 0);
    assert.equal((await tool('list_devices')).length, 0);
    const whoBefore = await tool('who_am_i');
    const nowDate = new Date();
    const expectedMonth = `${nowDate.getUTCFullYear()}-${String(nowDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const expectedReset = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1)).toISOString();
    assert.deepEqual(whoBefore, {
      user: 'owner@example.com',
      displayName: 'Owner',
      email: 'owner@example.com',
      username: null,
      role: 'admin',
      plan: 'pro',
      planExpiresAt: null,
      authMethods: ['google'],
      devices: { paired: 0, online: 0, offline: 0, selectedDevice: null },
      usage: {
        retainedCalls: 0,
        monthlyCalls: 0,
        billableMonthlyCalls: 0,
        activeTasks: 0,
        callQuota: null,
        planQuota: {
          plan: 'pro',
          planExpiresAt: null,
          month: expectedMonth,
          used: 0,
          limit: null,
          remaining: null,
          percent: 0,
          status: 'unlimited',
          warning: false,
          exceeded: false,
          resetAt: expectedReset
        },
        softQuota: null
      },
      version: pkgVersion
    });
    const store = new Store(db);
    assert.equal(store.db.prepare('SELECT count(*) AS total FROM tasks').get().total, 0);
    const invite = store.invite('invite-fixture', ['read']);
    store.db.close();
    const idFile = join(stateDir, 'identity.json');
    const dashboardAuth = async () => ({ Origin: origin, Cookie: dashCookie, 'X-CSRF-Token': dashCsrf });
    const authorizeDevice = async (login, name) => {
      const browserCode = await until(() => /user_code=([A-F0-9]+)/.exec(login.output())?.[1] || login.exitCode !== null && 'failed');
      assert.notEqual(browserCode, 'failed', login.output());
      const headers = await dashboardAuth();
      const details = await post(origin + '/manage/api/device-preview', { user_code: browserCode }, headers);
      assert.equal(details.status, 200);
      assert.ok((await details.json()).deviceName);
      const verified = await post(origin + '/manage/api/device-verify', {
        user_code: browserCode, capabilities: ['read', 'write', 'exec'], approve: true, name, approvalMode: 'strict'
      }, headers);
      assert.equal(verified.status, 200);
      assert.equal((await post(origin + '/manage/api/device-preview', { user_code: browserCode }, headers)).status, 404);
    };
    if (tty) {
      await agentTerminal(['pair', config], invite, agentEnv, packedCli ? temp : undefined);
      const logout = startAgent('logout');
      const [logoutCode] = await once(logout, 'close');
      assert.equal(logoutCode, 0, logout.output());
    } else {
      const credential = secret();
      const paired = await post(origin + '/device/pair', { invite, credential });
      assert.equal(paired.status, 201);
      const revoked = await post(origin + '/device/revoke', {}, jwt(credential));
      assert.equal(revoked.status, 200);
    }
    assert.equal((await post(origin + '/device/pair', { invite, credential: secret() })).status, 401);
    agent = !packedCli && process.env.RCM_TEST_LAUNCH === '1' && process.platform !== 'win32'
        ? start([resolve('launch.sh'), config, '--no-browser'], { env: agentEnv }, '/bin/sh')
        : startAgent('connect', '--no-browser');
    await authorizeDevice(agent, 'fixture');
    const { id: device, credential } = JSON.parse(await until(() => readFile(idFile, 'utf8')));
    assert.equal((await post(origin + '/device/sync', {}, jwt(tokens.access_token))).status, 401);
    assert.equal((await fetch(resource, { headers: jwt(credential) })).status, 401);
    const deviceInfo = async () => (await tool('list_devices')).find(entry => entry.id === device);
    await until(async () => (await deviceInfo())?.online);
    await call('select_device', { device_id: device });
    assert.equal((await call('read_file', { deviceId: device, path: join(ws, 'hello.txt') })).isError, true);
    assert.equal((await call('remote_devices')).isError, true);

    const submit = (name, args = {}) => call(name, { device_id: device, ...args });
    const pendingCall = async (name, args) => {
      const response = await submit(name, args);
      const { call_id: id } = payload(response);
      assert.ok(id, JSON.stringify(response));
      return id;
    };
    const native = async (name, args = {}, approve = false) => {
      let response = await submit(name, args);
      let value;
      try { value = payload(response); } catch { /* native tool text */ }
      if (value?.call_id) {
        if (approve) await permission(value.call_id, 'approve');
        const outcome = await complete(value.call_id);
        assert.equal(outcome.status, 'succeeded', JSON.stringify(outcome));
        response = outcome.response;
      }
      assert.equal(response.isError, undefined, JSON.stringify(response));
      return response;
    };
    const denied = await pendingCall('write_file', { path: join(ws, 'hello.txt'), content: 'unauthorized' });
    await permission(denied, 'deny');
    assert.equal((await complete(denied)).status, 'denied');
    const cancelled = await pendingCall('write_file', { path: join(ws, 'hello.txt'), content: 'cancelled' });
    await tool('cancel_tool_call', { call_id: cancelled });
    assert.equal((await complete(cancelled)).status, 'cancelled');
    assert.match(await readFile(join(ws, 'hello.txt'), 'utf8'), /needle/);

    const nativeRead = await native('read_file', { path: join(ws, 'hello.txt'), offset: -1 });
    assert.match(nativeRead.content[0].text, /second line/);
    const written = await native('write_file', { path: join(ws, 'native.txt'), content: 'native append', mode: 'rewrite' }, true);
    assert.ok(written.structuredContent || written.content.length);
    const batch = await native('read_multiple_files', { paths: [join(ws, 'native.txt'), join(ws, 'hello.txt')] });
    assert.ok(batch.content.some(entry => entry.type === 'text' && /native append/.test(entry.text)));
    const whoAfter = await tool('who_am_i');
    assert.equal(whoAfter.user, 'owner@example.com');
    assert.equal(whoAfter.displayName, 'Owner');
    assert.equal(whoAfter.email, 'owner@example.com');
    assert.equal(whoAfter.role, 'admin');
    assert.equal(whoAfter.plan, 'pro');
    assert.deepEqual(whoAfter.authMethods, ['google']);
    assert.equal(whoAfter.devices.paired, 1);
    assert.equal(whoAfter.devices.online, 1);
    assert.equal(whoAfter.devices.offline, 0);
    assert.deepEqual(whoAfter.devices.selectedDevice, { id: device, name: 'fixture', online: true });
    assert.ok(whoAfter.usage.retainedCalls >= 1);
    assert.equal(whoAfter.usage.monthlyCalls, whoAfter.usage.retainedCalls);
    assert.equal(whoAfter.usage.callQuota, null);
    assert.equal(whoAfter.version, pkgVersion);
    const resources = await client.listResources();
    const desktopResources = resources.resources.filter(resource => resource.uri.startsWith('ui://desktop-commander/'));
    assert.equal(desktopResources.length, 2);
    const nativeResource = await client.readResource({ uri: desktopResources[0].uri });
    assert.ok(nativeResource.contents[0].text.length > 40000);
    const configResult = await native('get_config');
    assert.ok(configResult.structuredContent.config);

    const script = join(ws, 'reconnect.cjs');
    await writeFile(script, "setTimeout(() => console.log('completed with OWNER_KEY=' + Boolean(process.env.OWNER_KEY)), 2500);\n");
    const quote = value => '"' + value.replaceAll('"', '\\"') + '"';
    const command = (process.platform === 'win32' ? '& ' : '') + quote(process.execPath) + ' ' + quote(script);
    const started = await native('start_process', { command, timeout_ms: 100 }, true);
    const startText = started.content[0].text;
    const pid = Number(/(?:PID|pid)[^\d]*(\d+)/.exec(startText)?.[1]);
    assert.ok(pid > 0, startText);
    await stop(gateway);
    await startGateway(env);
    await until(async () => (await deviceInfo())?.online);
    await until(async () => {
      const output = await native('read_process_output', { pid, offset: -20 });
      return output.content[0].text.includes('completed with OWNER_KEY=false');
    });
    const reconnected = await native('read_file', { path: join(ws, 'native.txt') });
    assert.match(reconnected.content[0].text, /native append/);

    const desktopStarts = async () => {
      const journal = await readFile(join(stateDir, 'client-events.jsonl'), 'utf8');
      return journal.trim().split('\n').map(line => JSON.parse(line))
        .filter(entry => entry.event === 'core_ready');
    };
    const initial = await until(async () => (await desktopStarts()).at(-1));
    process.kill(initial.pid, 'SIGKILL');
    await until(async () => {
      const latest = (await desktopStarts()).at(-1);
      return latest.pid !== initial.pid && latest;
    });
    await until(async () => (await deviceInfo()).online);
    const recovered = await native('read_file', { path: join(ws, 'native.txt') });
    assert.match(recovered.content[0].text, /native append/);
    const disconnect = await client.callTool({ name: 'shutdown', arguments: { device_id: device } });
    const shutdownTask = JSON.parse(disconnect.content[0].text).call_id;
    await permission(shutdownTask, 'approve');
    assert.equal((await complete(shutdownTask)).status, 'succeeded');
    await until(() => agent.exitCode !== null);
    assert.equal(agent.exitCode, 0, agent.output());
    assert.equal((await deviceInfo()).online, false);
    const savedIdentity = await readFile(idFile, 'utf8');
    agent = startAgent('connect', '--no-browser', '--no-persist-session');
    await authorizeDevice(agent, 'temporary');
    const temporary = await until(async () => (await tool('list_devices')).find(entry => entry.name === 'temporary' && entry.online));
    assert.equal(await readFile(idFile, 'utf8'), savedIdentity);
    const disconnectTemporary = await client.callTool({ name: 'shutdown', arguments: { device_id: temporary.id } });
    const temporaryShutdownTask = JSON.parse(disconnectTemporary.content[0].text).call_id;
    await permission(temporaryShutdownTask, 'approve');
    assert.equal((await complete(temporaryShutdownTask)).status, 'succeeded');
    await until(() => agent.exitCode !== null);
    assert.equal(agent.exitCode, 0, agent.output());
    assert.equal((await tool('list_devices')).find(entry => entry.id === temporary.id).revoked, true);
    assert.equal(await readFile(idFile, 'utf8'), savedIdentity);
    const history = async (args = {}) => JSON.parse((await client.callTool({ name: 'list_remote_tool_calls', arguments: args })).content[0].text);
    const calls = await history();
    assert.ok(calls.some(call => call.call_id === shutdownTask && call.tool_name === 'shutdown'));
    assert.ok(calls.some(call => call.call_id === temporaryShutdownTask && call.device_id === temporary.id));
    assert.ok(calls.some(call => call.tool_name === 'write_file' && call.status === 'succeeded'));
    assert.equal(calls.some(call => call.tool_name === 'read_multiple_files'), false);
    assert.deepEqual((await history({ device_id: temporary.id, limit: 1 })).map(call => call.call_id), [temporaryShutdownTask]);

    agent = startAgent('connect', '--no-browser');
    await until(async () => (await tool('list_devices')).find(entry => entry.id === device)?.online);
    assert.doesNotMatch(agent.output(), /user_code=/);
    const revokeAll = await post(origin + '/manage/api/devices/revoke-all', {}, await dashboardAuth());
    assert.equal(revokeAll.status, 200);
    assert.equal((await revokeAll.json()).revokedDevices, 1);
    await until(() => agent.exitCode !== null);
    assert.equal((await deviceInfo()).revoked, true);
    assert.ok((await deviceInfo()).lastSeen);
    await rename(ws, ws + '-unavailable');
    const report = startAgent('report');
    const [reportCode] = await once(report, 'close');
    assert.equal(reportCode, 0, report.output());
    const reportFile = /Diagnostics saved: (.+)/.exec(report.output())[1].trim();
    const { default: Zip } = await import('pizzip');
    const zip = new Zip(await readFile(reportFile));
    const reportText = zip.file('report.json').asText();
    const eventsText = zip.file('client-events.jsonl').asText();
    assert.equal(JSON.parse(reportText).checks.workspace.exists, false);
    await rename(ws + '-unavailable', ws);
    assert.match(eventsText, /core_disconnected/);
    assert.match(eventsText, /pairing_revoked/);
    for (const value of [credential, owner, clientSecret, 'native append']) {
      assert.ok(!reportText.includes(value) && !eventsText.includes(value));
    }
    const logout = startAgent('logout');
    const [logoutCode] = await once(logout, 'close');
    assert.equal(logoutCode, 0, logout.output());
    await assert.rejects(() => readFile(join(stateDir, 'identity.json')), /ENOENT/);
  } catch (e) { t.diagnostic(stdout()); throw e; }
  finally { await client?.close(); await stop(agent); await stop(gateway); proxy?.closeAllConnections(); proxy?.close(); globalThis.fetch = originalFetch; await rm(temp, { recursive: true, force: true }); }
});

test('RCM_MONTHLY_SOFT_QUOTA surfaces soft alert in who_am_i without blocking device calls', { timeout: 20000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-soft-quota-'));
  const db = join(temp, 'gateway.sqlite');
  const p = await port();
  const origin = `http://127.0.0.1:${p}`;
  const env = {
    ...process.env,
    STATE_DB: db,
    PUBLIC_ORIGIN: origin,
    ALLOW_INSECURE_LOOPBACK: '1',
    PORT: String(p),
    BIND_HOST: '127.0.0.1',
    OWNER_KEY: secret(),
    GOOGLE_CLIENT_ID: 'fixture-google-client',
    GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
    RCM_MONTHLY_SOFT_QUOTA: '2',
    RCM_SYNC_WAIT_MS: '1000'
  };
  let gateway, client;
  try {
    const seedStore = new Store(db);
    const created = seedStore.createGoogleUser({
      sub: 'e2e-soft-quota-sub',
      email: 'softquota@example.com',
      displayName: 'Soft Quota User',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(created.status, 'ok');
    const accessToken = secret();
    seedStore.putAuth(accessToken, 'access', 3600000, { userId: created.user.id, scope: 'remote:use' });
    const catalog = JSON.parse(await readFile('vendor/desktop-commander-full/catalog.json', 'utf8'));
    const dev = seedStore.pair(seedStore.invite('SoftBox', ['read'], created.user.id), secret());
    const boot = secret();
    seedStore.sync(dev.id, boot, 'linux', [], catalog);
    // Seed 2 completed calls in the current month (100% of RCM_MONTHLY_SOFT_QUOTA=2)
    for (let i = 0; i < 2; i++) {
      const task = seedStore.submit(dev.id, 'dc_call', { tool: 'read_file', arguments: { path: 'x.txt' } }, created.user.id);
      seedStore.finish(task.id, 'succeeded', 'ok');
    }
    seedStore.db.close();

    gateway = start(['dist/gateway.js'], { env });
    await until(async () => (await fetch(origin + '/healthz')).ok);

    client = new Client({ name: 'soft-quota-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: jwt(accessToken) } }));
    const whoRes = await client.callTool({ name: 'who_am_i', arguments: {} });
    const who = JSON.parse(whoRes.content[0].text);
    assert.equal(who.usage.monthlyCalls, 2);
    assert.equal(who.usage.softQuota.limit, 2);
    assert.equal(who.usage.softQuota.status, 'exceeded');
    assert.equal(who.usage.softQuota.warning, true);
    assert.equal(who.usage.softQuota.blocking, false);
    assert.match(who.usage.softQuota.message, /not blocked/);

    // Verify self-hosted device calls are NOT blocked when soft quota is exceeded
    const readRes = await client.callTool({ name: 'read_file', arguments: { device_id: dev.id, path: 'y.txt' } });
    const readPayload = JSON.parse(readRes.content[0].text);
    assert.equal(readRes.isError, undefined);
    assert.ok(readPayload.call_id);
    assert.equal(readPayload.status, 'queued');
  } finally {
    await client?.close();
    await stop(gateway);
    await rm(temp, { recursive: true, force: true });
  }
});

test('RCM_RESULT_TTL_MINUTES purges expired task payloads while get_tool_result returns clear metadata notice', { timeout: 20000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-result-ttl-'));
  const db = join(temp, 'gateway.sqlite');
  const p = await port();
  const origin = `http://127.0.0.1:${p}`;
  const env = {
    ...process.env,
    STATE_DB: db,
    PUBLIC_ORIGIN: origin,
    ALLOW_INSECURE_LOOPBACK: '1',
    PORT: String(p),
    BIND_HOST: '127.0.0.1',
    OWNER_KEY: secret(),
    GOOGLE_CLIENT_ID: 'fixture-google-client',
    GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
    RCM_RESULT_TTL_MINUTES: '1'
  };
  let gateway, client;
  try {
    const seedStore = new Store(db);
    const created = seedStore.createGoogleUser({
      sub: 'e2e-ttl-sub',
      email: 'ttl-e2e@example.com',
      displayName: 'TTL E2E User',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(created.status, 'ok');
    const accessToken = secret();
    seedStore.putAuth(accessToken, 'access', 3600000, { userId: created.user.id, scope: 'remote:use' });
    const dev = seedStore.pair(seedStore.invite('TTLBox', ['read'], created.user.id), secret());
    seedStore.sync(dev.id, secret(), 'linux', []);

    const expired = seedStore.submit(dev.id, 'dc_call', { tool: 'read_file', arguments: { path: '/secret/expired.txt' } }, created.user.id);
    seedStore.finish(expired.id, 'succeeded', 'TOP_SECRET_FILE_BODY', { content: [{ type: 'text', text: 'TOP_SECRET_MCP_BODY' }] });
    seedStore.db.prepare('UPDATE tasks SET changed=? WHERE id=?').run(Date.now() - 2 * 60_000, expired.id);
    seedStore.db.close();

    gateway = start(['dist/gateway.js'], { env });
    await until(async () => (await fetch(origin + '/healthz')).ok);

    client = new Client({ name: 'ttl-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: jwt(accessToken) } }));

    const toolRes = await client.callTool({ name: 'get_tool_result', arguments: { call_id: expired.id } });
    assert.equal(toolRes.isError, undefined);
    const body = JSON.parse(toolRes.content[0].text);
    assert.equal(body.call_id, expired.id);
    assert.equal(body.status, 'succeeded');
    assert.equal(body.toolName, 'read_file');
    assert.equal(body.payloadPurged, true);
    assert.ok(body.payloadPurgedAt);
    assert.equal(body.output, null);
    assert.equal(Object.hasOwn(body, 'result'), false);
    assert.match(body.notice, /automatically purged/i);
    assert.equal(JSON.stringify(body).includes('TOP_SECRET'), false);
  } finally {
    await client?.close();
    await stop(gateway);
    await rm(temp, { recursive: true, force: true });
  }
});

test('Free plan quota enforces 80% notice, 100% device call pause while keeping devices online, and Pro redeem recovery', { timeout: 25000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-free-quota-e2e-'));
  const db = join(temp, 'gateway.sqlite');
  const p = await port();
  const origin = `http://127.0.0.1:${p}`;
  const env = {
    ...process.env,
    STATE_DB: db,
    PUBLIC_ORIGIN: origin,
    ALLOW_INSECURE_LOOPBACK: '1',
    PORT: String(p),
    BIND_HOST: '127.0.0.1',
    OWNER_KEY: secret(),
    GOOGLE_CLIENT_ID: 'fixture-google-client',
    GOOGLE_CLIENT_SECRET: 'fixture-google-secret'
  };
  let gateway, client;
  let stopDeviceLoop = false;
  let deviceLoop;
  try {
    const catalog = JSON.parse(await readFile('vendor/desktop-commander-full/catalog.json', 'utf8'));
    const seedStore = new Store(db);
    const adminRes = seedStore.createGoogleUser({
      sub: 'e2e-fq-admin',
      email: 'fq-admin@example.com',
      displayName: 'FQ Admin',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(adminRes.status, 'ok');
    seedStore.setRegistrationMode('open');
    const freeRes = seedStore.createGoogleUser({
      sub: 'e2e-fq-user',
      email: 'fq-user@example.com',
      displayName: 'FQ User',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(freeRes.status, 'ok');
    const freeId = freeRes.user.id;
    seedStore.db.prepare('UPDATE users SET custom_monthly_quota=5 WHERE id=?').run(freeId);

    const accessToken = secret();
    seedStore.putAuth(accessToken, 'access', 3600000, { userId: freeId, scope: 'remote:use' });
    const dashToken = secret();
    const dashCsrf = secret();
    seedStore.putAuth(dashToken, 'dashboard', 3600000, { csrf: dashCsrf, userId: freeId, username: freeRes.user.email, role: 'user' });
    const dashCookie = `rcm_dashboard=${dashToken}`;

    const devCred = secret();
    const dev = seedStore.pair(seedStore.invite('FreeBox', ['read'], freeId), devCred);
    const boot = randomUUID();
    seedStore.sync(dev.id, boot, 'linux', [], catalog);
    // Seed 4 billable calls (80% of quota 5)
    for (let i = 0; i < 4; i++) {
      const t = seedStore.submit(dev.id, 'dc_call', { tool: 'read_file', arguments: { path: 'a.txt' } }, freeId);
      seedStore.finish(t.id, 'succeeded', 'ok');
    }
    const proCode = seedStore.createRedeemCode(adminRes.user.id, { tier: 'monthly', maxUses: 1 });
    seedStore.db.close();

    gateway = start(['dist/gateway.js'], { env });
    await until(async () => (await fetch(origin + '/healthz')).ok);

    // Lightweight simulated device worker answering /device/sync
    let seq = 1;
    deviceLoop = (async () => {
      let updates = [];
      while (!stopDeviceLoop) {
        try {
          const syncRes = await post(origin + '/device/sync', { boot, platform: 'linux', updates, ready: true }, jwt(devCred));
          if (syncRes.ok) {
            const reply = await syncRes.json();
            updates = (reply.jobs || []).map(job => ({
              id: job.id,
              seq: seq++,
              status: 'succeeded',
              output: 'device ok',
              result: { content: [{ type: 'text', text: 'device ok' }] }
            }));
          }
        } catch { /* ignore on shutdown */ }
        await delay(80);
      }
    })();

    client = new Client({ name: 'free-quota-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: jwt(accessToken) } }));

    // 5th call (starting from 4/5 = 80%) is allowed and includes [Quota Notice]
    const who80 = JSON.parse((await client.callTool({ name: 'who_am_i', arguments: {} })).content[0].text);
    assert.equal(who80.plan, 'free');
    assert.equal(who80.usage.billableMonthlyCalls, 4);
    assert.equal(who80.usage.planQuota.status, 'warning');

    const call5 = await client.callTool({ name: 'read_file', arguments: { device_id: dev.id, path: 'b.txt' } });
    assert.equal(call5.isError, undefined);
    assert.equal(call5.content[0].text, 'device ok');
    assert.match(call5.content[1].text, /Quota Notice.*5\/5 \(100%\)/);

    // 6th call (at 5/5 = 100%) is blocked, while device remains paired/online and control tools still work
    const call6 = await client.callTool({ name: 'read_file', arguments: { device_id: dev.id, path: 'c.txt' } });
    assert.equal(call6.isError, true);
    assert.match(call6.content[0].text, /Monthly Free plan quota reached \(5\/5\)/);

    const devices = JSON.parse((await client.callTool({ name: 'list_devices', arguments: {} })).content[0].text);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].online, true);
    assert.equal(devices[0].revoked, false);

    // Redeem Pro code via dashboard API -> immediately restores device calls
    const redeemRes = await post(
      origin + '/manage/api/plan/redeem',
      { code: proCode.code },
      { Origin: origin, Cookie: dashCookie, 'X-CSRF-Token': dashCsrf }
    );
    assert.equal(redeemRes.status, 200);
    assert.equal((await redeemRes.json()).planQuota.plan, 'pro');

    const whoPro = JSON.parse((await client.callTool({ name: 'who_am_i', arguments: {} })).content[0].text);
    assert.equal(whoPro.plan, 'pro');
    assert.ok(whoPro.planExpiresAt);

    const call7 = await client.callTool({ name: 'read_file', arguments: { device_id: dev.id, path: 'd.txt' } });
    assert.equal(call7.isError, undefined);
    assert.equal(call7.content.length, 1);
    assert.equal(call7.content[0].text, 'device ok');
  } finally {
    stopDeviceLoop = true;
    await deviceLoop;
    await client?.close();
    await stop(gateway);
    await rm(temp, { recursive: true, force: true });
  }
});

test('HTTP Long Polling achieves low dispatch latency, >95% idle sync reduction, and pending-results recovery without write replay', { timeout: 45000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-longpoll-e2e-'));
  const ws = join(temp, 'workspace'), stateDir = join(temp, 'private'), config = join(temp, 'agent.json');
  const db = join(temp, 'gateway.sqlite');
  const gwPort = await port();
  const proxyPort = await port();
  const gwOrigin = `http://127.0.0.1:${gwPort}`;
  const proxyOrigin = `http://127.0.0.1:${proxyPort}`;
  let syncRequests = 0;
  let dropNextTerminalSync = false;
  let droppedTerminal = false;
  const { createServer: httpCreateServer } = await import('node:http');
  const countingProxy = httpCreateServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      if (req.method === 'POST' && req.url === '/device/sync') {
        syncRequests++;
        if (dropNextTerminalSync && !droppedTerminal) {
          try {
            const parsed = JSON.parse(rawBody.toString('utf8'));
            if (Array.isArray(parsed.updates) && parsed.updates.some(u => u.status === 'succeeded' || u.status === 'failed')) {
              droppedTerminal = true;
              dropNextTerminalSync = false;
              res.writeHead(502).end('simulated transient disconnect');
              return;
            }
          } catch { /* ignore */ }
        }
      }
      const upstream = httpRequest(gwOrigin + req.url, { method: req.method, headers: req.headers }, r => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(503).end(); else res.end(); });
      upstream.end(rawBody);
    });
  });

  let gateway, agent, client;
  try {
    await countingProxy.listen(proxyPort, '127.0.0.1');
    await once(countingProxy, 'listening');
    await mkdir(ws);
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(join(ws, 'lp.txt'), 'fast long poll data\n');
    await writeFile(join(ws, 'append.txt'), '');
    await writeFile(config, JSON.stringify({ gateway: proxyOrigin, workspace: ws, stateDir, allowInsecureLoopback: true }));

    const seedStore = new Store(db);
    const created = seedStore.createGoogleUser({
      sub: 'e2e-lp-sub',
      email: 'lp-e2e@example.com',
      displayName: 'LP E2E',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(created.status, 'ok');
    const accessToken = secret();
    seedStore.putAuth(accessToken, 'access', 3600000, { userId: created.user.id, scope: 'remote:use' });
    const devCred = secret();
    const dev = seedStore.pair(seedStore.invite('LP-Box', ['read', 'write'], created.user.id, 'client'), devCred);
    await writeFile(join(stateDir, 'identity.json'), JSON.stringify({ origin: proxyOrigin, id: dev.id, credential: devCred }), { mode: 0o600 });
    seedStore.db.close();

    const env = {
      ...process.env,
      STATE_DB: db,
      PUBLIC_ORIGIN: proxyOrigin,
      ALLOW_INSECURE_LOOPBACK: '1',
      PORT: String(gwPort),
      BIND_HOST: '127.0.0.1',
      OWNER_KEY: secret(),
      GOOGLE_CLIENT_ID: 'fixture-google-client',
      GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
      RCM_SYNC_WAIT_MS: '15000',
      RCM_LONG_POLL_MS: '25000'
    };
    const agentEnv = { ...env, RCM_AGENT_LONG_POLL_MS: '25000' };

    gateway = start(['dist/gateway.js'], { env });
    await until(async () => (await fetch(proxyOrigin + '/healthz')).ok);
    agent = start(['dist/agent.js', 'run', config], { env: agentEnv });

    client = new Client({ name: 'lp-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(proxyOrigin + '/mcp'), { requestInit: { headers: jwt(accessToken) } }));
    await until(async () => {
      const devs = JSON.parse((await client.callTool({ name: 'list_devices', arguments: {} })).content[0].text);
      return devs.find(d => d.id === dev.id)?.online;
    });

    // Wait briefly for initial catalog sync to settle into an idle long-poll, then check idle traffic
    await delay(250);
    const baselineSyncs = syncRequests;
    await delay(2200);
    assert.ok(syncRequests - baselineSyncs <= 1, `Expected <=1 idle sync in 2.2s with 25s long polling, got ${syncRequests - baselineSyncs}`);

    // Immediate event wakeup + synchronous return under RCM_SYNC_WAIT_MS=15000
    const t0 = performance.now();
    const readRes = await client.callTool({ name: 'read_file', arguments: { device_id: dev.id, path: join(ws, 'lp.txt') } });
    const elapsedMs = performance.now() - t0;
    assert.equal(readRes.isError, undefined);
    assert.match(readRes.content[0].text, /fast long poll data/);
    assert.ok(elapsedMs < 1500, `Expected fast long-poll roundtrip, took ${Math.round(elapsedMs)}ms`);

    // Simulate transient 502 dropping the terminal /device/sync response on a write call, then kill Agent before ack
    dropNextTerminalSync = true;
    const writePromise = client.callTool({
      name: 'write_file',
      arguments: { device_id: dev.id, path: join(ws, 'append.txt'), content: 'ONCE_ONLY\n', mode: 'append' }
    });
    const pendingDir = join(stateDir, 'pending-results');
    await until(async () => droppedTerminal && (await readdir(pendingDir)).some(f => f.endsWith('.json')));
    // Kill crashed Agent abruptly (SIGKILL), remove lock, and start a fresh Agent (new boot)
    agent.kill('SIGKILL');
    await once(agent, 'exit');
    await rm(join(stateDir, 'identity.lock'), { recursive: true, force: true });
    await rm(join(stateDir + '.lock'), { recursive: true, force: true }).catch(() => {});

    agent = start(['dist/agent.js', 'run', config], { env: agentEnv });
    const writeOutcome = await writePromise;
    assert.equal(writeOutcome.isError, undefined);
    assert.match(writeOutcome.content[0].text, /Successfully|wrote|append/i);

    // Verify buffered file cleaned up after ack and write operation executed strictly once
    await until(async () => (await readdir(pendingDir)).filter(f => f.endsWith('.json')).length === 0);
    const writtenText = await readFile(join(ws, 'append.txt'), 'utf8');
    assert.equal(writtenText.match(/ONCE_ONLY/g)?.length, 1);
  } finally {
    await client?.close();
    await stop(agent);
    await stop(gateway);
    countingProxy.closeAllConnections();
    countingProxy.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('Gateway enforces execution lease renewal and per-user backpressure with cross-device wakeup', { timeout: 25000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'rcm-lease-backpressure-'));
  const db = join(temp, 'gateway.sqlite');
  const p = await port();
  const origin = `http://127.0.0.1:${p}`;
  const env = {
    ...process.env,
    STATE_DB: db,
    PUBLIC_ORIGIN: origin,
    ALLOW_INSECURE_LOOPBACK: '1',
    PORT: String(p),
    BIND_HOST: '127.0.0.1',
    OWNER_KEY: secret(),
    GOOGLE_CLIENT_ID: 'fixture-google-client',
    GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
    RCM_SYNC_WAIT_MS: '3000',
    RCM_LONG_POLL_MS: '15000',
    RCM_TASK_LEASE_MS: '1000',
    RCM_MAX_USER_ACTIVE: '1',
    RCM_MAX_USER_WAITING: '2'
  };
  let gateway, client;
  const ac = new AbortController();
  try {
    const catalog = JSON.parse(await readFile('vendor/desktop-commander-full/catalog.json', 'utf8'));
    const seedStore = new Store(db);
    const userRes = seedStore.createGoogleUser({
      sub: 'e2e-bp-sub',
      email: 'bp@example.com',
      displayName: 'BP User',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(userRes.status, 'ok');
    const accessToken = secret();
    seedStore.putAuth(accessToken, 'access', 3600000, { userId: userRes.user.id, scope: 'remote:use' });
    const credA = secret(), credB = secret();
    const devA = seedStore.pair(seedStore.invite('DevA', ['read'], userRes.user.id), credA);
    const devB = seedStore.pair(seedStore.invite('DevB', ['read'], userRes.user.id), credB);
    const bootA = randomUUID(), bootB = randomUUID();
    seedStore.sync(devA.id, bootA, 'linux', [], catalog);
    seedStore.sync(devB.id, bootB, 'linux', [], catalog);
    seedStore.db.close();

    gateway = start(['dist/gateway.js'], { env });
    await until(async () => (await fetch(origin + '/healthz')).ok);

    client = new Client({ name: 'bp-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: jwt(accessToken) } }));

    // devA takes Task 1, holds it > 1s while renewing its lease
    const res1Promise = client.callTool({ name: 'read_file', arguments: { device_id: devA.id, path: 'a.txt' } });
    const pollA1 = await (await post(origin + '/device/sync', { boot: bootA, platform: 'linux', updates: [], ready: true, waitMs: 5000 }, jwt(credA))).json();
    assert.equal(pollA1.jobs.length, 1);
    const job1 = pollA1.jobs[0];

    // Renew lease at 500ms so job1 stays alive past initial 1000ms lease
    await delay(500);
    await post(origin + '/device/sync', { boot: bootA, platform: 'linux', updates: [{ id: job1.id, seq: 2, status: 'running', output: 'renewed' }], ready: true }, jwt(credA));

    // Put devB in a long poll, submit b1 (wakes devB immediately with 0 slots), then submit b2 (maxUserWaiting=2) and verify b3 hits limit
    const pollBPromise = fetch(origin + '/device/sync', {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', ...jwt(credB) },
      body: JSON.stringify({ boot: bootB, platform: 'linux', updates: [], ready: true, waitMs: 5000 })
    }).then(r => r.json());

    const b1Promise = client.callTool({ name: 'read_file', arguments: { device_id: devB.id, path: 'b1.txt' } });
    const wokenInitial = await pollBPromise;
    assert.equal(wokenInitial.jobs.length, 0);

    const b2Promise = client.callTool({ name: 'read_file', arguments: { device_id: devB.id, path: 'b2.txt' } });
    await delay(80);
    const b3Res = await client.callTool({ name: 'read_file', arguments: { device_id: devB.id, path: 'b3.txt' } });
    assert.equal(b3Res.isError, true);
    assert.match(b3Res.content[0].text, /account task queue is full/);

    const pollBWaiting = fetch(origin + '/device/sync', {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', ...jwt(credB) },
      body: JSON.stringify({ boot: bootB, platform: 'linux', updates: [], ready: true, waitMs: 5000 })
    }).then(r => r.json());

    // Wait past initial 1000ms lease before completing job1 on devA -> frees userActive slot and wakes devB's long poll!
    await delay(550);
    const wakeAt = performance.now();
    await post(origin + '/device/sync', {
      boot: bootA,
      platform: 'linux',
      updates: [{ id: job1.id, seq: 3, status: 'succeeded', output: 'a-ok', result: { content: [{ type: 'text', text: 'a-ok' }] } }],
      ready: true
    }, jwt(credA));

    const res1 = await res1Promise;
    assert.equal(res1.isError, undefined);
    assert.equal(res1.content[0].text, 'a-ok');

    const pollBDispatched = await pollBWaiting;
    assert.ok(performance.now() - wakeAt < 1000, 'Sibling device devB should wake up immediately when devA finishes');
    assert.equal(pollBDispatched.jobs.length, 1);

    // Finish b1 on devB and cancel/complete b2 so b1Promise resolves cleanly
    await post(origin + '/device/sync', {
      boot: bootB,
      platform: 'linux',
      updates: [{ id: pollBDispatched.jobs[0].id, seq: 1, status: 'succeeded', output: 'b-ok', result: { content: [{ type: 'text', text: 'b-ok' }] } }],
      ready: true
    }, jwt(credB));
    const b1Res = await b1Promise;
    assert.equal(b1Res.content[0].text, 'b-ok');
    await b2Promise;
  } finally {
    ac.abort();
    await client?.close();
    await stop(gateway);
    await rm(temp, { recursive: true, force: true });
  }
});
