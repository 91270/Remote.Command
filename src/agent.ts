import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, unlink, readdir, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, type AgentConfig } from './agent-config.js';
import { createAgentUi, formatDuration } from './agent-ui.js';
import { agentClientId, approvalMs, capability, catalog, coreResult, clip, defaultLongPollMs, errorText, hash, maxActive, maxLongPollMs, needsLocalApproval, offlineMs, operations, projectVersion, secret, syncReply, terminal, update, uuid, work, type ApprovalMode, type Capability, type Update, type Work, type Catalog } from './protocol.js';
import { programEnv } from './workspace.js';
import { clientEvents } from './client-events.js';
import { deviceLogin, deviceLogout, deviceReport, deviceStatus, agentLock, keepAwake, identity, identityFile, requireUnpaired, saveIdentity, withIdentityLock, revokeIdentity, type DeviceIdentity } from './client-commands.js';

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const proposal = z.strictObject({ job: work, expires: z.number().int(), nonce: uuid });
const pendingTerminalTtlMs = 30 * 60_000;
const pendingTerminalMaxCount = 32;
const persistedTerminal = z.strictObject({
  deviceId: uuid,
  origin: z.string(),
  boot: uuid,
  savedAt: z.number().int(),
  update
});
const filename = (cfg: AgentConfig, id: string, extension: 'pending' | 'decision') => join(cfg.approvals, `${uuid.parse(id)}.${extension}.json`);
const pendingResultFile = (cfg: AgentConfig, id: string) => join(cfg.pendingResults, `${uuid.parse(id)}.json`);
function agentIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}.`);
  return n;
}
async function removePendingTerminal(cfg: AgentConfig, id: string) {
  await unlink(pendingResultFile(cfg, id)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}
async function savePendingTerminal(cfg: AgentConfig, deviceId: string, boot: string, st: Update) {
  const target = pendingResultFile(cfg, st.id);
  const tmp = `${target}.${randomUUID()}.tmp`;
  const payload = JSON.stringify({ deviceId, origin: cfg.origin, boot, savedAt: Date.now(), update: st });
  try {
    await writeFile(tmp, payload, { flag: 'wx', mode: 0o600 });
    await rename(tmp, target);
  } catch {
    await unlink(tmp).catch(() => {});
  }
}
async function loadPendingTerminals(cfg: AgentConfig, deviceId: string): Promise<Map<string, Update>> {
  const loaded: { savedAt: number; file: string; entry: Update }[] = [];
  const files = await readdir(cfg.pendingResults).catch(() => [] as string[]);
  const now = Date.now();
  for (const file of files) {
    const path = join(cfg.pendingResults, file);
    if (!/^[\da-f-]{36}\.json$/.test(file)) {
      if (file.endsWith('.tmp')) await unlink(path).catch(() => {});
      continue;
    }
    try {
      const parsed = persistedTerminal.parse(JSON.parse(await readFile(path, 'utf8')));
      if (
        parsed.deviceId !== deviceId ||
        parsed.origin !== cfg.origin ||
        now - parsed.savedAt > pendingTerminalTtlMs ||
        !terminal.some(s => s === parsed.update.status)
      ) {
        await unlink(path).catch(() => {});
        continue;
      }
      loaded.push({ savedAt: parsed.savedAt, file: path, entry: { ...parsed.update, boot: parsed.boot } });
    } catch {
      await unlink(path).catch(() => {});
    }
  }
  loaded.sort((a, b) => b.savedAt - a.savedAt);
  const kept = loaded.slice(0, pendingTerminalMaxCount);
  for (const dropped of loaded.slice(pendingTerminalMaxCount)) {
    await unlink(dropped.file).catch(() => {});
  }
  return new Map(kept.map(item => [item.entry.id, item.entry]));
}
const fetchJson = (
  cfg: AgentConfig,
  path: string,
  payload: object,
  credential?: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
) => {
  const timeoutSignal = AbortSignal.timeout(options?.timeoutMs ?? 7000);
  const signal = options?.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
  return fetch(cfg.origin + path, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) },
    body: JSON.stringify(payload)
  });
};
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

function summarizeJob(job: Work): string {
  if (job.op === 'dc_call') {
    const toolName = String(job.args.tool ?? 'dc_call');
    const rawArgs = JSON.stringify(job.args.arguments ?? {});
    const shortArgs = rawArgs.length > 220 ? rawArgs.slice(0, 220) + '…' : rawArgs;
    return `${toolName} ${shortArgs}`;
  }
  return `${job.op} ${JSON.stringify(job.args).slice(0, 220)}`;
}

type RunOptions = {
  debug: boolean;
  verbose: boolean;
  serviceMode: boolean;
  logToFile: boolean;
  noSleepActive: boolean;
  sessionSource: 'persisted' | 'paired' | 'temporary';
  allowAutoRepair?: boolean;
};

async function run(cfg: AgentConfig, auth: DeviceIdentity, opts: RunOptions) {
  if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') throw new Error('Unsupported platform.');
  if (auth.origin !== cfg.origin) throw new Error('The pairing is bound to another Gateway.');
  const logDir = opts.logToFile ? join(cfg.stateDir, 'logs') : undefined;
  const ui = createAgentUi({ verbose: opts.verbose, debug: opts.debug, serviceMode: opts.serviceMode, logDir });
  ui.banner();
  ui.debug(`Verbose mode: ${opts.verbose}, Debug mode: ${opts.debug}`);
  if (opts.noSleepActive) ui.info('☕ No sleep mode enabled (macOS caffeinate)');
  else if (process.platform === 'darwin') ui.info('💤 No sleep mode disabled');
  ui.info('🚀 Starting Remote.Command Agent...');
  ui.substep('⏳ Connecting to local Desktop Commander core...');
  if (opts.sessionSource === 'persisted') ui.info(`💾 Found persisted session for device ${auth.id}`);
  else if (opts.sessionSource === 'temporary') ui.info(`🧪 Using temporary session for device ${auth.id}`);
  else ui.info(`🔐 Paired new session for device ${auth.id}`);
  ui.info(`⏳ Connecting to Remote Gateway ${cfg.origin}`);

  const agentLongPollMs = agentIntEnv('RCM_AGENT_LONG_POLL_MS', defaultLongPollMs, 0, maxLongPollMs);
  const leaseRenewMs = agentIntEnv('RCM_AGENT_LEASE_RENEW_MS', 30_000, 200, 120_000);
  const events = clientEvents(cfg.stateDir);
  events.record({ event: 'starting' });
  const boot = randomUUID(), shutdown = new AbortController();
  let lastSync = 0;
  let syncOnline = false;
  let disconnectTask: string | undefined;
  let retryExecutorAt = 0;
  let executorFailures = 0;
  let completed = 0;
  let dirtyVersion = 0;
  let wakeSync: AbortController | undefined;
  let inFlightLongPollAbort: AbortController | undefined;
  let executorRecovery: Promise<void> | undefined;
  let promptChain: Promise<void> = Promise.resolve();
  let approvalMode: ApprovalMode = 'client';
  let grantedCapabilities: Capability[] = ['read', 'write', 'exec'];
  let deviceName = hostname().slice(0, 128) || 'Remote Command Agent';
  let userEmail: string | undefined;
  let hadCoreReady = false;
  let hasSynced = false;
  let hasPrintedReady = false;
  let offlineSince = 0;
  let unreachableAttempts = 0;
  let autoRepairing = false;
  type Active = { state: Update; abort: AbortController; finished?: Promise<void> };
  const jobs = new Map<string, Active>();
  const syncedSeq = new Map<string, number>();
  const pendingTerminals = await loadPendingTerminals(cfg, auth.id);
  let dcClient: Client | undefined;
  let dcConnecting: Promise<Client> | undefined;
  let dcCatalog: Catalog | undefined;
  let catalogSynced = false;
  const notifyDirty = () => {
    dirtyVersion++;
    inFlightLongPollAbort?.abort('dirty');
    wakeSync?.abort();
  };
  const leaseTimer = setInterval(() => {
    let renewed = false;
    for (const active of jobs.values()) {
      if (active.state.status === 'running' || active.state.status === 'awaiting_approval') {
        active.state = { ...active.state, seq: active.state.seq + 1 };
        renewed = true;
      }
    }
    if (renewed) notifyDirty();
  }, leaseRenewMs);
  leaseTimer.unref?.();
  const desktopCore = () => {
    if (dcClient) return Promise.resolve(dcClient);
    dcConnecting ??= (async () => {
      const c = new Client({ name: agentClientId, version: projectVersion });
      c.onclose = () => {
        if (dcClient !== c) return;
        dcClient = undefined;
        dcCatalog = undefined;
        catalogSynced = false;
        notifyDirty();
        if (!shutdown.signal.aborted) {
          events.record({ event: 'core_disconnected' });
          ui.coreDisconnected();
        }
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
        notifyDirty();
        events.record({ event: 'core_ready', pid: transport.pid ?? undefined });
        if (!hadCoreReady) {
          hadCoreReady = true;
          ui.substep(`🔌 Connected to local core (${dcCatalog.tools.length} tools ready)`);
        } else {
          ui.coreRecovered(dcCatalog.tools.length);
        }
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
      ui.debug(`Local core readiness check failed; retrying in ${formatDuration(retryExecutorAt - Date.now())}`);
    }).finally(() => { executorRecovery = undefined; });
  }
  const onSignal = () => shutdown.abort();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, onSignal);
  function enqueueForegroundApproval(
    job: Work,
    request: string,
    pendingFile: string,
    decisionFile: string,
    jobSignal: AbortSignal
  ): () => void {
    if (opts.serviceMode || !process.stdin.isTTY || !process.stdout.isTTY) return () => {};
    const promptAbort = new AbortController();
    const stop = () => promptAbort.abort();
    jobSignal.addEventListener('abort', stop, { once: true });
    shutdown.signal.addEventListener('abort', stop, { once: true });

    promptChain = promptChain.then(async () => {
      if (promptAbort.signal.aborted || !existsSync(pendingFile) || existsSync(decisionFile)) return;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const onAbort = () => rl.close();
      promptAbort.signal.addEventListener('abort', onAbort, { once: true });
      try {
        ui.approvalPromptHeader(summarizeJob(job));
        const answer = (await rl.question('Approve this operation? Type y to approve / n to deny [y/N]: ', { signal: promptAbort.signal })).trim().toLowerCase();
        const decision = answer === 'y' || answer === 'yes' ? 'approve' : 'deny';
        await writeFile(decisionFile, JSON.stringify({ decision, digest: hash(request) }), { flag: 'wx', mode: 0o600 }).catch(err => {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        });
        ui.approvalDecision(decision === 'approve');
      } catch {
        // Aborted by expiry, cancellation, shutdown, or external CLI decide
      } finally {
        promptAbort.signal.removeEventListener('abort', onAbort);
        rl.close();
      }
    }).catch(() => {});

    return () => {
      stop();
      jobSignal.removeEventListener('abort', stop);
      shutdown.signal.removeEventListener('abort', stop);
    };
  }
  function start(job: Work, cancel: boolean) {
    if (jobs.has(job.id) || pendingTerminals.has(job.id) || jobs.size >= maxActive) return;
    const active: Active = { state: { id: job.id, status: 'running', seq: 1 }, abort: new AbortController() };
    jobs.set(job.id, active);
    if (cancel) active.abort.abort();
    const startedAt = Date.now();
    const toolName = job.op === 'dc_call' ? String(job.args.tool ?? 'dc_call') : job.op;
    const toolArgs = job.op === 'dc_call' ? (job.args.arguments ?? {}) : job.args;
    ui.toolReceived(job.id, toolName, toolArgs);
    const state = (status: Update['status'], output?: string, result?: Update['result'], wake = true) => {
      if (active.state.status !== status || active.state.output !== output || result !== undefined) {
        active.state = {
          id: job.id,
          status,
          seq: active.state.seq + 1,
          ...(output !== undefined ? { output } : {}),
          ...(result !== undefined ? { result } : {})
        };
        if (wake) notifyDirty();
      }
    };
    active.finished = (async () => {
      const { signal } = active.abort;
      let effective: ReturnType<typeof capability> | undefined;
      try {
        signal.throwIfAborted();
        effective = capability(job.op, job.args);
        if (!grantedCapabilities.includes(effective)) throw new Error('Operation is not permitted for this device pairing.');
        const args = operations[job.op].parse(job.args);
        if (needsLocalApproval(approvalMode, effective)) {
          const req = { job: { ...job, args }, nonce: randomUUID(), expires: Date.now() + approvalMs };
          const request = JSON.stringify(req);
          const pending = filename(cfg, job.id, 'pending'), decision = filename(cfg, job.id, 'decision');
          await writeFile(pending, request, { flag: 'wx', mode: 0o600 });
          state('awaiting_approval', 'Confirm on the device (press y/n in the Agent terminal or use the Agent CLI). Approval expires after five minutes.');
          ui.toolAwaitingApproval(job.id, toolName);
          const cancelPrompt = enqueueForegroundApproval(job, request, pending, decision, signal);
          try {
            for (;;) {
              signal.throwIfAborted();
              if (Date.now() >= req.expires) { state('denied', 'Local approval expired.'); return; }
              if (syncOnline || Date.now() - lastSync < offlineMs) {
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
          } finally {
            cancelPrompt();
            await Promise.all([pending, decision].map(f => unlink(f).catch(() => {})));
          }
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
          state(result.isError ? 'failed' : 'succeeded', clip(output), result, false);
        }
      } catch (e) {
        const cancelled = signal.aborted;
        state(cancelled ? (effective === 'write' && active.state.status === 'running' ? 'interrupted' : 'cancelled') : 'failed',
          cancelled ? 'Cancellation received. If a write had already begun, check the workspace before retrying.' : clip(errorText(e)),
          undefined, false);
      } finally {
        const graceInterrupted = shutdown.signal.aborted && (active.state.status === 'cancelled' || active.state.status === 'interrupted');
        if (!graceInterrupted && terminal.some(s => s === active.state.status)) {
          if (pendingTerminals.size >= pendingTerminalMaxCount) {
            const oldest = pendingTerminals.keys().next().value;
            if (oldest) {
              pendingTerminals.delete(oldest);
              await removePendingTerminal(cfg, oldest);
            }
          }
          pendingTerminals.set(job.id, { ...active.state, boot });
          await savePendingTerminal(cfg, auth.id, boot, active.state);
        }
        ui.toolFinished(job.id, toolName, active.state.status, Date.now() - startedAt, active.state.output);
        completed++;
        notifyDirty();
      }
    })();
  }
  async function poll(): Promise<{ ready: boolean; wokeLocally: boolean }> {
    const ready = !disconnectTask && !!dcClient;
    const catalogToSend = dcCatalog;
    const needsCatalog = !catalogSynced && !!catalogToSend;

    const updatesToSend: Update[] = [];
    const queuedIds = new Set<string>();
    for (const active of jobs.values()) {
      if (updatesToSend.length >= 8) break;
      if (terminal.some(s => s === active.state.status)) {
        updatesToSend.push(active.state);
        queuedIds.add(active.state.id);
      }
    }
    for (const buffered of pendingTerminals.values()) {
      if (updatesToSend.length >= 8) break;
      if (!queuedIds.has(buffered.id)) {
        updatesToSend.push(buffered);
        queuedIds.add(buffered.id);
      }
    }
    for (const active of jobs.values()) {
      if (updatesToSend.length >= 8) break;
      if (!queuedIds.has(active.state.id) && active.state.seq > (syncedSeq.get(active.state.id) ?? 0)) {
        updatesToSend.push(active.state);
        queuedIds.add(active.state.id);
      }
    }

    const canLongPoll = agentLongPollMs > 0 && ready && !disconnectTask && updatesToSend.length === 0 && !needsCatalog;
    const lpAbort = canLongPoll ? new AbortController() : undefined;
    if (lpAbort) inFlightLongPollAbort = lpAbort;
    const signal = lpAbort ? AbortSignal.any([shutdown.signal, lpAbort.signal]) : shutdown.signal;
    const timeoutMs = canLongPoll ? agentLongPollMs + 10_000 : 7000;

    let response: Response;
    let replyJson: unknown;
    try {
      response = await fetchJson(cfg, '/device/sync', {
        boot,
        platform: process.platform,
        ready,
        updates: updatesToSend,
        ...(needsCatalog ? { catalog: catalogToSend } : {}),
        ...(canLongPoll ? { waitMs: agentLongPollMs } : {})
      }, auth.credential, { timeoutMs, signal });
      if (response.status === 401 || response.status === 409) {
        const revokedOnStartup = response.status === 401 && !hasSynced;
        const err = new EnrollmentEnded('Agent pairing was revoked or replaced; stop and check device enrollment.', revokedOnStartup);
        events.record({ event: 'pairing_revoked' });
        syncOnline = false;
        if (revokedOnStartup && opts.allowAutoRepair) {
          autoRepairing = true;
          ui.warn('⚠️ Saved device pairing was revoked on the Gateway. Clearing stale session and re-pairing...');
        } else {
          ui.error('⚠️ Agent pairing was revoked or replaced; stopping.');
        }
        shutdown.abort(err);
        throw err;
      }
      if (!response.ok) throw new Error(`Gateway sync HTTP ${response.status}`);
      replyJson = await response.json();
    } catch (err) {
      if (lpAbort?.signal.aborted && !shutdown.signal.aborted) {
        return { ready, wokeLocally: true };
      }
      throw err;
    } finally {
      if (inFlightLongPollAbort === lpAbort) inFlightLongPollAbort = undefined;
    }

    const reply = syncReply.parse(replyJson);
    hasSynced = true;
    syncOnline = true;
    lastSync = Date.now();
    for (const u of updatesToSend) {
      if (!terminal.some(s => s === u.status)) {
        syncedSeq.set(u.id, Math.max(syncedSeq.get(u.id) ?? 0, u.seq));
      }
    }
    if (reply.deviceName) deviceName = reply.deviceName;
    if (reply.userEmail) userEmail = reply.userEmail;
    if (reply.capabilities?.length) {
      const same = reply.capabilities.length === grantedCapabilities.length
        && reply.capabilities.every((cap, index) => cap === grantedCapabilities[index]);
      if (!same) {
        grantedCapabilities = reply.capabilities;
        if (hasPrintedReady) ui.info(`🛡️ Permissions synced: ${grantedCapabilities.join(', ')}`);
      }
    }
    if (reply.approvalMode && reply.approvalMode !== approvalMode) {
      approvalMode = reply.approvalMode;
      if (hasPrintedReady) ui.approvalModeChanged(approvalMode);
    }
    if (catalogToSend && catalogToSend === dcCatalog) catalogSynced = true;
    if (disconnectTask && reply.ack.includes(disconnectTask)) shutdown.abort();
    for (const id of reply.ack) {
      if (jobs.has(id) && terminal.some(s => s === jobs.get(id)!.state.status)) jobs.delete(id);
      syncedSeq.delete(id);
      if (pendingTerminals.delete(id)) {
        void removePendingTerminal(cfg, id);
      }
    }
    for (const id of reply.cancel) jobs.get(id)?.abort.abort();
    if (!shutdown.signal.aborted && !disconnectTask) {
      for (const job of reply.jobs) start(job, reply.cancel.includes(job.id));
      if (!ready) recoverExecutor();
    }
    return { ready, wokeLocally: false };
  }
  recoverExecutor();
  let retry = 700, connected = false, disconnectedNotice = false;
  try {
    while (!shutdown.signal.aborted) {
      const sentCompletion = completed;
      const sentDirty = dirtyVersion;
      let synced = false;
      let ready = false;
      let wokeLocally = false;
      try {
        const outcome = await poll();
        ready = outcome.ready;
        wokeLocally = outcome.wokeLocally;
        synced = !wokeLocally;
        if (synced) {
          if (ready && !connected) {
            events.record({ event: 'gateway_online' });
            if (!hasPrintedReady) {
              hasPrintedReady = true;
              if (opts.sessionSource === 'persisted') ui.substep('✅ Session restored');
              ui.info('🔌 Device marked as online');
              ui.ready({
                userEmail,
                deviceId: auth.id,
                deviceName,
                gateway: cfg.origin,
                workspace: cfg.workspace,
                capabilities: grantedCapabilities,
                approvalMode,
                version: projectVersion,
                logDir,
                coreToolsCount: dcCatalog?.tools.length
              });
            } else if (offlineSince > 0) {
              ui.gatewayReconnected(Date.now() - offlineSince);
            } else {
              ui.info('🔌 Device is back online.');
            }
            offlineSince = 0;
            unreachableAttempts = 0;
          } else if (!ready && connected && !disconnectTask) {
            ui.warn('⚠️ Local Desktop Commander core is unavailable; restarting the executor...');
          }
          connected = ready;
          disconnectedNotice = false;
          retry = 700;
        }
      } catch (e) {
        if (shutdown.signal.aborted) throw e;
        syncOnline = false;
        lastSync = 0;
        syncedSeq.clear();
        unreachableAttempts++;
        if (!disconnectedNotice) {
          events.record({ event: 'gateway_unreachable' });
          offlineSince = Date.now();
          disconnectedNotice = true;
        }
        connected = false;
        retry = Math.min(7000, retry * 2);
        ui.gatewayUnreachable(errorText(e), retry, unreachableAttempts);
      }
      if (wokeLocally || (synced && (completed !== sentCompletion || dirtyVersion !== sentDirty || (ready && !disconnectTask && agentLongPollMs > 0)))) {
        continue;
      }
      wakeSync = synced ? new AbortController() : undefined;
      const signal = wakeSync ? AbortSignal.any([shutdown.signal, wakeSync.signal]) : shutdown.signal;
      await delay(retry + Math.round(Math.random() * 200), undefined, { signal }).catch(() => {});
      wakeSync = undefined;
    }
  } finally {
    clearInterval(leaseTimer);
    syncOnline = false;
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.off(sig, onSignal);
    if (!autoRepairing) ui.disconnecting(disconnectTask ? 'remote disconnect requested' : undefined);
    for (const job of jobs.values()) job.abort.abort();
    await Promise.allSettled([...jobs.values()].map(j => j.finished));
    await executorRecovery;
    await dcClient?.close().catch(() => {});
    await fetchJson(cfg, '/device/offline', { boot }, auth.credential).catch(() => {});
    events.record({ event: 'stopped' });
    await events.flush();
    if (!autoRepairing) ui.disconnected();
  }
}
const help = `Usage: remote-command agent connect|run|login|pair|logout|report|status|approvals CONFIG
       remote-command agent decide CONFIG TASK approve|deny

connect pairs in a browser when no local identity exists and then starts the Agent.
  --no-browser            Print the pairing URL without opening a browser.
  --no-persist-session    Pair for this run without saving credentials.
  --disable-no-sleep      Disable macOS keep-awake.
  -v, --verbose           Show expanded tool arguments and output previews.
  --log-file              Write plain-text rotating logs under <stateDir>/logs.
  --debug                 Show executor recovery details.`;
class EnrollmentEnded extends Error {
  readonly revokedOnStartup: boolean;
  constructor(message: string, revokedOnStartup = false) {
    super(message);
    this.revokedOnStartup = revokedOnStartup;
  }
}
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
    let sessionSource: 'persisted' | 'paired' | 'temporary' = 'persisted';
    try {
      if (temporary) {
        sessionSource = 'temporary';
        auth = await deviceLogin(cfg, !args.includes('--no-browser'), false);
      } else {
        const raw = await readFile(identityFile(cfg), 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        if (raw) {
          sessionSource = 'persisted';
          auth = identity.parse(JSON.parse(raw));
        } else if (cmd === 'connect') {
          sessionSource = 'paired';
          auth = await deviceLogin(cfg, !args.includes('--no-browser'));
        } else if (args.includes('--service')) { console.error('Pair the device before starting the background Agent.'); return; }
        else throw new Error('No device identity. Run connect or pair first.');
      }
      const awake = keepAwake(cfg.noSleep && !args.includes('--disable-no-sleep'));
      const debug = args.includes('--debug');
      const verbose = args.includes('--verbose') || args.includes('-v');
      const serviceMode = args.includes('--service');
      const logToFile = cfg.logToFile || args.includes('--log-file');
      const allowAutoRepair = cmd === 'connect' && !serviceMode && !temporary && sessionSource === 'persisted';
      try {
        await run(cfg, auth, { debug, verbose, serviceMode, logToFile, noSleepActive: awake.active, sessionSource, allowAutoRepair });
      } catch (error) {
        if (error instanceof EnrollmentEnded && error.revokedOnStartup && allowAutoRepair) {
          await withIdentityLock(cfg, () => unlink(identityFile(cfg)).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') throw err;
          }));
          auth = await deviceLogin(cfg, !args.includes('--no-browser'));
          await run(cfg, auth, { debug, verbose, serviceMode, logToFile, noSleepActive: awake.active, sessionSource: 'paired', allowAutoRepair: false });
        } else if (!serviceMode || !(error instanceof EnrollmentEnded)) {
          throw error;
        } else {
          console.error(error.message);
        }
      } finally {
        awake.stop();
      }
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
