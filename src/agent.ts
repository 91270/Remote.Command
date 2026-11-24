import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, type AgentConfig } from './agent-config.js';
import { agentClientId, approvalMs, capability, catalog, coreResult, clip, errorText, hash, maxActive, operations, projectVersion, secret, syncReply, terminal, uuid, work, type Update, type Work, type Catalog } from './protocol.js';
import { programEnv } from './workspace.js';
import { clientEvents } from './client-events.js';
import { deviceLogin, deviceLogout, deviceReport, deviceStatus, agentLock, keepAwake, identity, identityFile, requireUnpaired, saveIdentity, withIdentityLock, revokeIdentity, type DeviceIdentity } from './client-commands.js';

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const proposal = z.strictObject({ job: work, expires: z.number().int(), nonce: uuid });
const filename = (cfg: AgentConfig, id: string, extension: 'pending' | 'decision') => join(cfg.approvals, `${uuid.parse(id)}.${extension}.json`);
const fetchJson = (cfg: AgentConfig, path: string, payload: object, credential?: string) => fetch(cfg.origin + path, {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(7000),
  headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) },
  body: JSON.stringify(payload)
});
async function ask(prompt: string) {
  if (!process.stdin.isTTY) throw new Error('Run this command in a local terminal.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(prompt); } finally { rl.close(); }
}
async function enroll(cfg: AgentConfig) {
  return withIdentityLock(cfg, async () => {
    await requireUnpaired(cfg);
    const invite = token.parse((await ask('Gateway pairing token: ')).trim());
    const credential = secret();
    const response = await fetchJson(cfg, '/device/pair', { invite, credential });
    if (response.status !== 201) throw new Error('Pairing rejected or expired.');
    const { id } = z.object({ id: uuid }).parse(await response.json());
    await saveIdentity(cfg, { origin: cfg.origin, id, credential });
    console.log('Paired device:', id);
  });
}
async function decide(cfg: AgentConfig, id: string, decision: string) {
  if (!['approve', 'deny'].includes(decision)) throw new Error('Decision must be approve or deny.');
  const raw = await readFile(filename(cfg, id, 'pending'), 'utf8');
  const request = proposal.parse(JSON.parse(raw));
  if (Date.now() >= request.expires || request.job.id !== id) throw new Error('Approval expired.');
  console.log(JSON.stringify(request, null, 2));
  if (await ask(`Type ${decision} to confirm this exact request: `) !== decision) throw new Error('No decision recorded.');
  if (Date.now() >= request.expires) throw new Error('Approval expired.');
  await writeFile(filename(cfg, id, 'decision'), JSON.stringify({ decision, digest: hash(raw) }), { flag: 'wx', mode: 0o600 });
  console.log('Decision recorded.');
}
async function approvals(cfg: AgentConfig) {
  for (const file of await readdir(cfg.approvals)) {
    if (!/^[\da-f-]{36}\.pending\.json$/.test(file)) continue;
    try {
      const p = proposal.parse(JSON.parse(await readFile(join(cfg.approvals, file), 'utf8')));
      if (Date.now() < p.expires) console.log(JSON.stringify({ id: p.job.id, operation: p.job.op, expires: new Date(p.expires).toISOString() }));
    } catch { /* file may have been removed after listing */ }
  }
}

async function run(cfg: AgentConfig, auth: DeviceIdentity, debug: boolean) {
  if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') throw new Error('Unsupported platform.');
  if (auth.origin !== cfg.origin) throw new Error('The pairing is bound to another Gateway.');
  const events = clientEvents(cfg.stateDir);
  events.record({ event: 'starting' });
  const boot = randomUUID(), shutdown = new AbortController();
  let lastSync = 0;
  let disconnectTask: string | undefined;
  let retryExecutorAt = 0;
  let executorFailures = 0;
  let completed = 0;
  let wakeSync: AbortController | undefined;
  let executorRecovery: Promise<void> | undefined;
  type Active = { state: Update; abort: AbortController; finished?: Promise<void> };
  const jobs = new Map<string, Active>();
  let dcClient: Client | undefined;
  let dcConnecting: Promise<Client> | undefined;
  let dcCatalog: Catalog | undefined;
  let catalogSynced = false;
  const desktopCore = () => {
    if (dcClient) return Promise.resolve(dcClient);
    dcConnecting ??= (async () => {
      const c = new Client({ name: agentClientId, version: projectVersion });
      c.onclose = () => {
        if (dcClient !== c) return;
        dcClient = undefined;
        dcCatalog = undefined;
        catalogSynced = false;
        if (!shutdown.signal.aborted) events.record({ event: 'core_disconnected' });
      };
      const coreState = join(cfg.stateDir, 'core');
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('dc-core.js', import.meta.url))],
        cwd: cfg.workspace,
        env: {
          ...programEnv() as Record<string, string>,
          RCM_CORE_STATE: coreState, RCM_WORKSPACE: cfg.workspace,
          ...(cfg.ripgrep ? { RCM_RIPGREP: cfg.ripgrep } : {}),
          ...(cfg.chromePath ? { RCM_CHROME_PATH: cfg.chromePath } : {})
        },
        stderr: 'ignore'
      });
      try {
        await c.connect(transport, { timeout: 8000 });
        const discovery = { timeout: 8000, signal: shutdown.signal };
        const [tools, resources] = await Promise.all([c.listTools({}, discovery), c.listResources({}, discovery)]);
        dcCatalog = catalog.parse({ tools: tools.tools, resources: resources.resources });
        dcClient = c;
        catalogSynced = false;
        events.record({ event: 'core_ready', pid: transport.pid ?? undefined });
        return c;
      } catch (e) { await transport.close(); throw e; }
    })().finally(() => { dcConnecting = undefined; });
    return dcConnecting;
  };
  function recoverExecutor() {
    if (executorRecovery || Date.now() < retryExecutorAt || shutdown.signal.aborted) return;
    executorRecovery = desktopCore().then(() => {
      executorFailures = 0;
      retryExecutorAt = 0;
    }, () => {
      retryExecutorAt = Date.now() + Math.min(5000, 500 * 2 ** Math.min(4, executorFailures++));
      events.record({ event: 'core_retry' });
      if (debug) console.error('Local MCP failed readiness checks. Retry delay:', retryExecutorAt - Date.now(), 'ms');
    }).finally(() => { executorRecovery = undefined; });
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => shutdown.abort());
  function start(job: Work, cancel: boolean) {
    if (jobs.has(job.id) || jobs.size >= maxActive) return;
    const active: Active = { state: { id: job.id, status: 'running', seq: 1 }, abort: new AbortController() };
    jobs.set(job.id, active);
    if (cancel) active.abort.abort();
    const state = (status: Update['status'], output?: string) => {
      if (active.state.status !== status || active.state.output !== output)
        active.state = { id: job.id, status, seq: active.state.seq + 1, output };
    };
    active.finished = (async () => {
      const { signal } = active.abort;
      let effective: ReturnType<typeof capability> | undefined;
      try {
        signal.throwIfAborted();
        effective = capability(job.op, job.args);
        if (!cfg.capabilities.includes(effective)) throw new Error('Operation denied by local Agent configuration.');
        const args = operations[job.op].parse(job.args);
        if (effective !== 'read') {
          const req = { job: { ...job, args }, nonce: randomUUID(), expires: Date.now() + approvalMs };
          const request = JSON.stringify(req);
          const pending = filename(cfg, job.id, 'pending'), decision = filename(cfg, job.id, 'decision');
          await writeFile(pending, request, { flag: 'wx', mode: 0o600 });
          state('awaiting_approval', 'Confirm on the device with the Agent CLI. Approval expires after five minutes.');
          try {
            for (;;) {
              signal.throwIfAborted();
              if (Date.now() >= req.expires) { state('denied', 'Local approval expired.'); return; }
              if (Date.now() - lastSync < 3500) {
                const data = await readFile(decision, 'utf8').catch(e => {
                  if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
                  throw e;
                });
                if (data) {
                  const verdict = z.strictObject({ decision: z.enum(['approve', 'deny']), digest: z.string() }).parse(JSON.parse(data));
                  if (verdict.digest !== hash(request)) throw new Error('Decision is not bound to this job.');
                  if (verdict.decision === 'deny') { state('denied', 'Denied on the device.'); return; }
                  break;
                }
              }
              await delay(250, undefined, { signal });
            }
          } finally { await Promise.all([pending, decision].map(f => unlink(f).catch(() => {}))); }
        }
        signal.throwIfAborted();
        state('running');
        if (job.op === 'disconnect') {
          state('succeeded', 'Remote Agent is disconnecting. Restart it locally to accept remote work again.');
          disconnectTask = job.id;
        } else {
          const core = await desktopCore();
          let result;
          if (job.op === 'dc_call') {
            const request = operations.dc_call.parse(args);
            if (!dcCatalog?.tools.some(tool => tool.name === request.tool)) throw new Error('Unknown local core tool.');
            result = coreResult.parse(await core.callTool({ name: request.tool, arguments: request.arguments },
              CallToolResultSchema, { signal, timeout: 180000 }));
          } else {
            const request = operations.dc_resource.parse(args);
            const resource = await core.readResource({ uri: request.uri }, { signal, timeout: 20000 });
            result = coreResult.parse({ content: [{ type: 'text', text: JSON.stringify(resource) }] });
          }
          const output = result.content.map(item => item.type === 'text' ? item.text : '[' + item.type + ']').join('\n');
          state(result.isError ? 'failed' : 'succeeded', clip(output));
          active.state = { ...active.state, result };
        }
      } catch (e) {
        const cancelled = signal.aborted;
        state(cancelled ? (effective === 'write' && active.state.status === 'running' ? 'interrupted' : 'cancelled') : 'failed',
          cancelled ? 'Cancellation received. If a write had already begun, check the workspace before retrying.' : clip(errorText(e)));
      } finally {
        completed++;
        wakeSync?.abort();
      }
    })();
  }
  async function poll() {
    const ready = !disconnectTask && !!dcClient;
    const catalogToSend = dcCatalog;
    const response = await fetchJson(cfg, '/device/sync', {
      boot, platform: process.platform, ready, updates: [...jobs.values()].map(j => j.state),
      ...(!catalogSynced && catalogToSend ? { catalog: catalogToSend } : {})
    }, auth.credential);
    if (response.status === 401 || response.status === 409) {
      const err = new EnrollmentEnded('Agent pairing was revoked or replaced; stop and check device enrollment.');
      events.record({ event: 'pairing_revoked' });
      shutdown.abort(err);
      throw err;
    }
    if (!response.ok) throw new Error(`Gateway sync HTTP ${response.status}`);
    const reply = syncReply.parse(await response.json());
    lastSync = Date.now();
    if (catalogToSend && catalogToSend === dcCatalog) catalogSynced = true;
    if (disconnectTask && reply.ack.includes(disconnectTask)) shutdown.abort();
    for (const id of reply.ack) if (jobs.has(id) && terminal.some(s => s === jobs.get(id)!.state.status)) jobs.delete(id);
    for (const id of reply.cancel) jobs.get(id)?.abort.abort();
    if (!shutdown.signal.aborted && !disconnectTask) {
      for (const job of reply.jobs) start(job, reply.cancel.includes(job.id));
      if (!ready) recoverExecutor();
    }
    return ready;
  }
  recoverExecutor();
  let retry = 700, connected = false, disconnectedNotice = false;
  try {
    while (!shutdown.signal.aborted) {
      const sentCompletion = completed;
      let synced = false;
      try {
        const ready = await poll();
        synced = true;
        if (ready && !connected) {
          events.record({ event: 'gateway_online' });
          console.log('Agent online:', auth.id);
        } else if (!ready && connected && !disconnectTask) {
          console.error('Local MCP is unavailable. Restarting the executor.');
        }
        connected = ready;
        disconnectedNotice = false;
        retry = 700;
      } catch (e) {
        if (shutdown.signal.aborted) throw e;
        lastSync = 0;
        if (!disconnectedNotice) {
          events.record({ event: 'gateway_unreachable' });
          console.error('Gateway unreachable; retrying.');
          disconnectedNotice = true;
        }
        connected = false;
        retry = Math.min(7000, retry * 2);
      }
      // Keep one sync in flight. A completion during its request still needs another sync.
      if (synced && completed !== sentCompletion) continue;
      wakeSync = synced ? new AbortController() : undefined;
      const signal = wakeSync ? AbortSignal.any([shutdown.signal, wakeSync.signal]) : shutdown.signal;
      await delay(retry + Math.round(Math.random() * 200), undefined, { signal }).catch(() => {});
      wakeSync = undefined;
    }
  } finally {
    for (const job of jobs.values()) job.abort.abort();
    await Promise.allSettled([...jobs.values()].map(j => j.finished));
    await executorRecovery;
    await dcClient?.close().catch(() => {});
    await fetchJson(cfg, '/device/offline', { boot }, auth.credential).catch(() => {});
    events.record({ event: 'stopped' });
    await events.flush();
  }
}
const help = `Usage: agent connect|run|login|pair|logout|report|status|approvals CONFIG
       agent decide CONFIG TASK approve|deny

connect pairs in a browser when no local identity exists and then starts the Agent.
  --no-browser            Print the pairing URL without opening a browser.
  --no-persist-session    Pair for this run without saving credentials.
  --disable-no-sleep      Disable macOS keep-awake.
  --debug                 Show executor recovery details.`;
class EnrollmentEnded extends Error {}
export async function runAgentCli(argv: string[]) {
  const [cmd, file, ...args] = argv;
  if (cmd === '--help' || cmd === '-h') { console.log(help); return; }
  if (!file || !['connect', 'run', 'login', 'logout', 'report', 'status', 'pair', 'approvals', 'decide'].includes(cmd ?? '')) {
    throw new Error(help);
  }
  const cfg = await loadConfig(file, { diagnostics: cmd === 'report' });
  if (cmd === 'run' || cmd === 'connect') {
    const temporary = args.includes('--no-persist-session');
    if (temporary && cmd !== 'connect') throw new Error('Use connect for --no-persist-session.');
    const release = await agentLock(cfg);
    let auth: DeviceIdentity | undefined;
    try {
      if (temporary) {
        auth = await deviceLogin(cfg, !args.includes('--no-browser'), false);
      } else {
        const raw = await readFile(identityFile(cfg), 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        if (raw) auth = identity.parse(JSON.parse(raw));
        else if (cmd === 'connect') auth = await deviceLogin(cfg, !args.includes('--no-browser'));
        else if (args.includes('--service')) { console.error('Pair the device before starting the background Agent.'); return; }
        else throw new Error('No device identity. Run connect or pair first.');
      }
      const stopAwake = keepAwake(cfg.noSleep && !args.includes('--disable-no-sleep'));
      try { await run(cfg, auth, args.includes('--debug')); }
      catch (error) {
        if (!args.includes('--service') || !(error instanceof EnrollmentEnded)) throw error;
        console.error(error.message);
      }
      finally { stopAwake(); }
    } finally {
      try {
        if (temporary && auth) await revokeIdentity(cfg, auth);
      } finally { await release(); }
    }
  }
  if (cmd === 'login') await deviceLogin(cfg, !args.includes('--no-browser'));
  if (cmd === 'logout') await deviceLogout(cfg);
  if (cmd === 'report') await deviceReport(cfg);
  if (cmd === 'status') await deviceStatus(cfg);
  if (cmd === 'pair') await enroll(cfg);
  if (cmd === 'approvals') await approvals(cfg);
  if (cmd === 'decide') await decide(cfg, uuid.parse(args[0]), args[1] ?? '');
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try { await runAgentCli(process.argv.slice(2)); }
  catch (error) { console.error(errorText(error)); process.exitCode = 1; }
}
