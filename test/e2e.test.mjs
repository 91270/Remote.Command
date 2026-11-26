import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
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
    await writeFile(config, JSON.stringify({ gateway: agentOrigin, workspace: ws, stateDir, allowInsecureLoopback: !proxy,
      capabilities: ['read', 'write', 'exec'] }));
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
    assert.deepEqual(whoBefore, {
      user: 'owner@example.com',
      displayName: 'Owner',
      email: 'owner@example.com',
      username: null,
      role: 'admin',
      plan: 'pro',
      authMethods: ['google'],
      devices: { paired: 0, online: 0, offline: 0, selectedDevice: null },
      usage: { retainedCalls: 0, monthlyCalls: 0, activeTasks: 0, callQuota: null },
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
        user_code: browserCode, capabilities: ['read', 'write', 'exec'], approve: true, name
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
