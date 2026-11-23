import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, readFile, writeFile, rename, symlink, link, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { secret, hash } from '../dist/protocol.js';
import { Store } from '../dist/store.js';

const packedCli = process.env.PRM_TEST_PACKED_CLI;

async function until(fn, ms = 12000) {
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
const okTask = r => assert.equal(r.status, 'succeeded', JSON.stringify(r));

test('OAuth + Streamable HTTP + Gateway + Agent + local MCP, including reconnect and cancellation', { timeout: 180000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'prm-e2e-'));
  const ws = join(temp, 'workspace'), stateDir = join(temp, 'private'), config = join(temp, 'agent.json');
  const db = join(temp, 'gateway.sqlite'), p = await port(), agentPort = process.env.PRM_TEST_TLS === '1' ? await port() : p;
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
    BIND_HOST: '127.0.0.1', OAUTH_CLIENT_ID: clientId, OAUTH_CLIENT_SECRET: clientSecret, OWNER_KEY: owner, OAUTH_REDIRECT_URIS: redirect };
  const agentEnv = { ...env, ...(testCert && { NODE_EXTRA_CA_CERTS: testCert }) };
  const startAgent = (action, ...flags) => {
    if (!packedCli) return start(['dist/agent.js', action, config, ...flags], { env: agentEnv });
    const args = action === 'run' ? ['agent', action, config] : ['remote', '--config', config, ...flags];
    if (action === 'report') args.push('--report', '--no-upload');
    if (action === 'logout') args.push('--logout');
    return start([packedCli, ...args], { cwd: temp, env: agentEnv });
  };
  const tty = process.env.PRM_TEST_TTY === '1' && process.platform !== 'win32';
  let gateway, agent, client;
  const startGateway = async () => {
    gateway = start(['dist/gateway.js'], { env });
    await until(async () => (await fetch(origin + '/healthz')).ok);
  };
  const stdout = () => `Gateway: ${gateway?.output()}\nAgent: ${agent?.output()}`;
  const tool = async (name, args = {}) => {
    const r = await client.callTool({ name: 'remote_' + name, arguments: args });
    assert.equal(r.content[0]?.type, 'text', JSON.stringify(r));
    return JSON.parse(r.content[0].text);
  };
  const complete = (id, wanted) => until(async () => {
    const a = await tool('task_status', { task: id });
    return (wanted ? a.status === wanted : ['succeeded', 'failed', 'cancelled', 'timed_out', 'denied', 'interrupted'].includes(a.status)) && a;
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
    await writeFile(join(temp, 'outside.txt'), 'host-only content');
    let linked = false;
    try { await symlink(join(temp, 'outside.txt'), join(ws, 'escape.txt'), 'file'); linked = true; }
    catch (e) { if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(e.code)) throw e; }
    await link(join(temp, 'outside.txt'), join(ws, 'hardlink.txt'));
    const ripgrep = packedCli ? {} : { ripgrep: await realpath(process.env.RIPGREP_PATH ?? (process.platform === 'win32'
      ? execFileSync('where.exe', ['rg.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
      : execFileSync('sh', ['-c', 'command -v rg'], { encoding: 'utf8' }).trim())) };
    await writeFile(config, JSON.stringify({ gateway: agentOrigin, workspace: ws, stateDir, desktopCommander: process.env.PRM_TEST_FULL === '1', allowInsecureLoopback: !proxy,
      capabilities: ['read', 'write', 'exec'], ...ripgrep, profiles: { node: { executable: process.execPath } } }));
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
    const page = await (await fetch(issuer.authorization_endpoint + '?' + new URLSearchParams(authParams))).text();
    const base = { ...authParams, until: /name="until" value="([^"]+)"/.exec(page)[1], proof: /name="proof" value="([^"]+)"/.exec(page)[1] };
    assert.equal((await form(origin, '/oauth/authorize', { ...base, owner_key: secret() })).status, 403);
    const authorized = await form(origin, '/oauth/authorize', { ...base, owner_key: owner });
    assert.equal(authorized.status, 303);
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
    assert.ok(list.tools.length >= 19);
    assert.equal(client.getServerVersion().name, 'remote-command');
    const reviewTool = list.tools.find(tool => tool.name === 'review_device_call');
    const reviewUI = await client.readResource({ uri: reviewTool._meta.ui.resourceUri });
    assert.match(reviewUI.contents[0].text, /ui\/notifications\/tool-result/);
    const input = { tool_name: 'write_file', arguments: { path: 'preview-only.txt', content: 'never queued' }, summary: 'Inspect the proposed write.' };
    const proposed = await client.callTool({ name: 'review_device_call', arguments: input });
    assert.deepEqual(proposed.structuredContent.arguments, input.arguments);
    assert.equal(proposed.structuredContent.after_client_error, false);
    const blocked = await client.callTool({ name: 'review_device_call', arguments: { ...input, client_error: 'Blocked', likely_reason: 'Host validation declined the call.' } });
    assert.equal(blocked.structuredContent.after_client_error, true);
    assert.equal((await tool('devices')).length, 0);
    const full = process.env.PRM_TEST_FULL === '1';
    const store = new Store(db);
    assert.equal(store.db.prepare('SELECT count(*) AS total FROM tasks').get().total, 0);
    const invite = full ? secret() : store.invite('fixture', ['read', 'write', 'exec']);
    store.db.close();
    const idFile = join(stateDir, 'identity.json');
    const dashboardAuth = async () => {
      const response = await post(origin + '/manage/api/login', { ownerKey: owner }, { Origin: origin });
      const ownerSession = await response.json();
      const cookie = response.headers.get('set-cookie').split(';')[0];
      return { Origin: origin, Cookie: cookie, 'X-CSRF-Token': ownerSession.csrf };
    };
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
    if (full) {
      agent = !packedCli && process.env.PRM_TEST_LAUNCH === '1' && process.platform !== 'win32'
        ? start([resolve('launch.sh'), config, '--no-browser'], { env: agentEnv }, '/bin/sh')
        : startAgent('connect', '--no-browser');
      await authorizeDevice(agent, 'fixture');
      await until(() => readFile(idFile, 'utf8'));
    } else if (tty) await agentTerminal(['pair', config], invite, agentEnv, packedCli ? temp : undefined);
    else {
      const credential = secret();
      const paired = await post(origin + '/device/pair', { invite, credential });
      assert.equal(paired.status, 201);
      const { id } = await paired.json();
      await writeFile(idFile, JSON.stringify({ id, origin: agentOrigin, credential }), { mode: 0o600 });
    }
    const { id: device, credential } = JSON.parse(await readFile(idFile, 'utf8'));
    assert.equal((await post(origin + '/device/pair', { invite, credential: secret() })).status, 401);
    assert.equal((await post(origin + '/device/sync', {}, jwt(tokens.access_token))).status, 401);
    assert.equal((await fetch(resource, { headers: jwt(credential) })).status, 401);
    if (!full) {
      assert.equal((await tool('devices'))[0].online, false);
      agent = startAgent('run');
    }
    await until(async () => (await tool('devices'))[0]?.online);
    const submit = (op, args) => tool(op, { device, ...args });
    const done = async (op, args) => {
      const task = await submit(op, args);
      return ['succeeded', 'failed'].includes(task.status) ? task : complete(task.id);
    };
    const first = await done('read_file', { path: 'hello.txt', offset: 1, length: 1 });
    okTask(first);
    assert.match(first.output, /second line/);
    assert.doesNotMatch(first.output, /needle/);
    assert.equal((await done('read_file', { path: '../outside.txt' })).status, 'failed');
    assert.equal((await done('read_file', { path: 'hardlink.txt' })).status, 'failed');
    if (linked) assert.equal((await done('read_file', { path: 'escape.txt' })).status, 'failed');
    assert.equal((await done('read_file', { path: 'https://invalid.example/foo' })).status, 'failed');
    okTask(await done('get_file_info', { path: 'hello.txt' }));
    okTask(await done('list_directory', { path: '.' }));
    const search = await done('search', { path: '.', searchType: 'content', pattern: 'needle' });
    okTask(search);
    assert.match(search.output, /hello\.txt/);
    assert.doesNotMatch(search.output, /workspace[/\\]/);
    const names = await done('search', { path: '.', searchType: 'files', pattern: 'hello.txt' });
    okTask(names);
    assert.match(names.output, /hello\.txt/);
    const external = await done('search', { path: '.', searchType: 'content', pattern: 'host-only' });
    okTask(external);
    assert.deepEqual(JSON.parse(external.output).results, []);
    const writes = async (operation, args) => {
      const task = await submit(operation, args);
      assert.ok(task.id, JSON.stringify(task));
      await complete(task.id, 'awaiting_approval');
      await permission(task.id, 'approve');
      const outcome = await complete(task.id);
      okTask(outcome);
    };
    const denied = await submit('write_file', { path: 'hello.txt', content: 'unauthorized' });
    await complete(denied.id, 'awaiting_approval');
    assert.match(await readFile(join(ws, 'hello.txt'), 'utf8'), /needle/);
    await permission(denied.id, 'deny');
    assert.equal((await complete(denied.id)).status, 'denied');
    await writes('edit_block', { file_path: 'hello.txt', old_string: 'there is a needle\nsecond line', new_string: 'edited\nsecond line' });
    assert.equal(await readFile(join(ws, 'hello.txt'), 'utf8'), 'edited\r\nsecond line\r\n');
    await writes('create_directory', { path: 'sub' });
    await writes('write_file', { path: 'sub/new.txt', content: 'independent work' });
    await writes('move_file', { source: 'sub/new.txt', destination: 'sub/moved.txt' });
    assert.equal(await readFile(join(ws, 'sub/moved.txt'), 'utf8'), 'independent work');
    const command = (args, timeoutSeconds) => submit('start_command', { profile: 'node', args: ['-e', args], cwd: '.', timeoutSeconds });
    const running = await command('console.log("begin"); setTimeout(() => console.log("after reconnect", !!process.env.OWNER_KEY), 3100)', 15);
    const review = await permission(running.id, 'approve');
    assert.equal(review.command.executable.toLowerCase(), (await realpath(process.execPath)).toLowerCase());
    await until(async () => (await tool('task_status', { task: running.id })).output?.includes('begin'));
    assert.ok((await tool('tasks', { device, activeOnly: true })).some(task => task.id === running.id));
    await stop(gateway);
    await delay(3700);
    await startGateway();
    const completed = await complete(running.id);
    okTask(completed);
    assert.match(completed.output, /begin\s+after reconnect false/);
    const time = await command('console.log("deadline"); setTimeout(() => {}, 20000)', 1);
    await permission(time.id, 'approve');
    assert.equal((await complete(time.id)).status, 'timed_out');
    const cancelled = await command('console.log("can cancel"); setTimeout(() => {}, 30000)', 20);
    await permission(cancelled.id, 'approve');
    await until(async () => (await tool('task_status', { task: cancelled.id })).output?.includes('can cancel'));
    await tool('cancel_task', { task: cancelled.id });
    assert.equal((await complete(cancelled.id)).status, 'cancelled');
    if (process.env.PRM_TEST_FULL === '1') {
      const toolList = await client.listTools();
      assert.ok(toolList.tools.some(tool => tool.name === 'interact_with_process'));
      const native = async (name, args = {}, approve = false) => {
        let value = await client.callTool({ name, arguments: { device_id: device, ...args } });
        let pending;
        try { pending = JSON.parse(value.content[0]?.text); } catch {}
        if (pending?.call_id) {
          if (approve) await permission(pending.call_id, 'approve');
          await complete(pending.call_id);
          value = await client.callTool({ name: 'get_tool_result', arguments: { call_id: pending.call_id } });
        }
        assert.equal(value.isError, undefined, JSON.stringify(value));
        return value;
      };
      await client.callTool({ name: 'select_device', arguments: { device_id: device } });
      const nativeRead = await native('read_file', { path: join(ws, 'hello.txt'), offset: -1 });
      assert.match(nativeRead.content[0].text, /second line/);
      const written = await native('write_file', { path: join(ws, 'native.txt'), content: 'native append', mode: 'rewrite' }, true);
      assert.ok(written.structuredContent || written.content.length);
      const batch = await native('read_multiple_files', { paths: [join(ws, 'native.txt'), join(ws, 'hello.txt')] });
      assert.ok(batch.content.some(entry => entry.type === 'text' && /native append/.test(entry.text)));
      const resources = await client.listResources();
      const desktopResources = resources.resources.filter(resource => resource.uri.startsWith('ui://desktop-commander/'));
      assert.equal(desktopResources.length, 2);
      const resource = await client.readResource({ uri: desktopResources[0].uri });
      assert.ok(resource.contents[0].text.length > 40000);
      const configResult = await native('get_config');
      assert.ok(configResult.structuredContent.config);

      const desktopStarts = async () => {
        const journal = await readFile(join(stateDir, 'client-events.jsonl'), 'utf8');
        return journal.trim().split('\n').map(line => JSON.parse(line))
          .filter(entry => entry.event === 'core_ready' && entry.executor === 'desktop-commander');
      };
      const initial = await until(async () => (await desktopStarts()).at(-1));
      process.kill(initial.pid, 'SIGKILL');
      await until(async () => {
        const latest = (await desktopStarts()).at(-1);
        return latest.pid !== initial.pid && latest;
      });
      await until(async () => (await tool('devices'))[0]?.online);
      const recovered = await native('read_file', { path: join(ws, 'native.txt') });
      assert.match(recovered.content[0].text, /native append/);
      const disconnect = await client.callTool({ name: 'shutdown', arguments: { device_id: device } });
      const shutdownTask = JSON.parse(disconnect.content[0].text).call_id;
      await permission(shutdownTask, 'approve');
      assert.equal((await complete(shutdownTask)).status, 'succeeded');
      await until(() => agent.exitCode !== null);
      assert.equal(agent.exitCode, 0, agent.output());
      assert.equal((await tool('devices'))[0].online, false);
      const savedIdentity = await readFile(idFile, 'utf8');
      agent = startAgent('connect', '--no-browser', '--no-persist-session');
      await authorizeDevice(agent, 'temporary');
      const temporary = await until(async () => (await tool('devices')).find(entry => entry.name === 'temporary' && entry.online));
      assert.equal(await readFile(idFile, 'utf8'), savedIdentity);
      const disconnectTemporary = await client.callTool({ name: 'shutdown', arguments: { deviceId: temporary.id } });
      const temporaryShutdownTask = JSON.parse(disconnectTemporary.content[0].text).call_id;
      await permission(temporaryShutdownTask, 'approve');
      assert.equal((await complete(temporaryShutdownTask)).status, 'succeeded');
      await until(() => agent.exitCode !== null);
      assert.equal(agent.exitCode, 0, agent.output());
      assert.equal((await tool('devices')).find(entry => entry.id === temporary.id).revoked, true);
      assert.equal(await readFile(idFile, 'utf8'), savedIdentity);
      const history = async (args = {}) => JSON.parse((await client.callTool({ name: 'list_remote_tool_calls', arguments: args })).content[0].text);
      const calls = await history();
      assert.ok(calls.some(call => call.call_id === shutdownTask && call.tool_name === 'shutdown'));
      assert.ok(calls.some(call => call.call_id === temporaryShutdownTask && call.device_id === temporary.id));
      assert.ok(calls.some(call => call.tool_name === 'write_file' && call.status === 'succeeded'));
      assert.equal(calls.some(call => call.tool_name === 'read_multiple_files'), false);
      assert.deepEqual((await history({ deviceId: temporary.id, limit: 1 })).map(call => call.call_id), [temporaryShutdownTask]);

      agent = startAgent('connect', '--no-browser');
      await until(async () => (await tool('devices')).find(entry => entry.id === device)?.online);
      assert.doesNotMatch(agent.output(), /user_code=/);
    }
    const revokeAll = await post(origin + '/manage/api/devices/revoke-all', {}, await dashboardAuth());
    assert.equal(revokeAll.status, 200);
    assert.equal((await revokeAll.json()).revokedDevices, 1);
    await until(() => agent.exitCode !== null);
    assert.equal((await tool('devices'))[0].revoked, true);
    assert.ok((await tool('devices'))[0].lastSeen);
    if (process.env.PRM_TEST_FULL === '1') {
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
    }
  } catch (e) { t.diagnostic(stdout()); throw e; }
  finally { await client?.close(); await stop(agent); await stop(gateway); proxy?.closeAllConnections(); proxy?.close(); globalThis.fetch = originalFetch; await rm(temp, { recursive: true, force: true }); }
});
