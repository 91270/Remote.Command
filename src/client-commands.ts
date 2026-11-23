import { hostname, platform, arch, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readFile, writeFile, unlink, stat, rename, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { hash, secret, uuid, errorText } from './protocol.js';
import { recentClientEvents } from './client-events.js';
import type { AgentConfig } from './agent-config.js';

export const identity = z.strictObject({ origin: z.string(), id: uuid, credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const fetchDevice = (cfg: AgentConfig, path: string, data: object, credential?: string) => fetch(cfg.origin + path, {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(7000),
  headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}) },
  body: JSON.stringify(data)
});
export const identityFile = (cfg: AgentConfig) => join(cfg.stateDir, 'identity.json');
export type DeviceIdentity = z.infer<typeof identity>;

export async function withIdentityLock<T>(cfg: AgentConfig, operation: () => Promise<T>): Promise<T> {
  const name = 'proper-lockfile';
  const lock = await import(name);
  const release = await lock.default.lock(identityFile(cfg), {
    realpath: false, lockfilePath: join(cfg.stateDir, 'identity.lock'), stale: 20000, update: 5000, retries: 0
  });
  try { return await operation(); }
  finally { await release(); }
}

export async function requireUnpaired(cfg: AgentConfig) {
  const raw = await readFile(identityFile(cfg), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (raw.length > 0) throw new Error('This Agent already has an identity. Log out before pairing again.');
}

export async function saveIdentity(cfg: AgentConfig, auth: DeviceIdentity) {
  const file = identityFile(cfg);
  const temp = file + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(identity.parse(auth)), { flag: 'wx', mode: 0o600 });
  try { await rename(temp, file); }
  finally { await unlink(temp).catch(() => {}); }
}

function openBrowser(url: string) {
  const program = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(program, args, { stdio: 'ignore', shell: false, detached: true });
  child.on('error', () => console.log('Open the displayed pairing URL in your browser.'));
  child.unref();
}
async function browserEnrollment(cfg: AgentConfig, browser: boolean): Promise<DeviceIdentity> {
  const proof = secret(), credential = secret();
  const response = await fetchDevice(cfg, '/device/start', {
    client_id: 'private-remote-agent', device_name: hostname().slice(0, 80) || 'Remote Command Agent',
    code_challenge: hash(proof), code_challenge_method: 'S256'
  });
  if (!response.ok) throw new Error('Gateway could not start device authorization.');
  const offer = z.object({ device_code: z.string(), user_code: z.string(), verification_uri_complete: z.url(),
    expires_in: z.number().positive().max(600), interval: z.number().positive().max(30) }).parse(await response.json());
  const url = new URL(offer.verification_uri_complete);
  if (url.origin !== cfg.origin || url.pathname !== '/manage') throw new Error('Unexpected verification origin.');
  console.log('Pair this device in your browser:', url.href);
  console.log('Verify the device code:', offer.user_code);
  if (browser) openBrowser(url.href);
  const deadline = performance.now() + offer.expires_in * 1000;
  let interval = offer.interval * 1000;
  while (performance.now() < deadline) {
    await delay(interval);
    let result: Response;
    try {
      result = await fetchDevice(cfg, '/device/poll', {
        client_id: 'private-remote-agent', device_code: offer.device_code, code_verifier: proof, credential
      });
    } catch { continue; }
    if (result.status >= 500) continue;
    const payload = await result.json().catch(() => undefined);
    if (!payload) continue;
    if (result.ok) {
      const accepted = z.object({ device_id: uuid }).parse(payload);
      console.log('Paired device:', accepted.device_id);
      return { origin: cfg.origin, id: accepted.device_id, credential };
    }
    if (payload.error === 'slow_down') { interval = Math.min(30000, interval + 1000); continue; }
    if (payload.error === 'authorization_pending') continue;
    throw new Error('Pairing failed: ' + String(payload.error));
  }
  throw new Error('Device authorization expired.');
}

export async function deviceLogin(cfg: AgentConfig, browser = true, persist = true) {
  if (!persist) return browserEnrollment(cfg, browser);
  return withIdentityLock(cfg, async () => {
    await requireUnpaired(cfg);
    const auth = await browserEnrollment(cfg, browser);
    await saveIdentity(cfg, auth);
    return auth;
  });
}

export async function revokeIdentity(cfg: AgentConfig, auth: DeviceIdentity) {
  if (auth.origin !== cfg.origin) throw new Error('Pairing belongs to another Gateway.');
  const response = await fetchDevice(cfg, '/device/revoke', {}, auth.credential);
  const body = await response.json().catch(() => undefined);
  const revoked = response.ok && body?.success === true;
  const refused = response.status === 401 && body?.error === 'unauthorized';
  if (!revoked && !refused) throw new Error('Gateway did not confirm revocation.');
}
export async function deviceLogout(cfg: AgentConfig) {
  return withIdentityLock(cfg, async () => {
    const file = identityFile(cfg);
    const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (!raw) { console.log('This Agent has no saved identity.'); return; }
    const auth = identity.parse(JSON.parse(raw));
    try { await revokeIdentity(cfg, auth); }
    catch { throw new Error('Gateway did not confirm revocation. Credentials retained for retry.'); }
    await unlink(file);
    console.log('Device revoked and local pairing removed.');
  });
}
export async function deviceReport(cfg?: AgentConfig) {
  const outputDir = cfg?.stateDir ?? join(homedir(), '.remote-command', 'diagnostics');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const checks: Record<string, unknown> = {};
  let deviceId: string | null = null;
  checks.configured = !!cfg;
  if (cfg) {
    try {
      const auth = identity.parse(JSON.parse(await readFile(join(cfg.stateDir, 'identity.json'), 'utf8')));
      deviceId = auth.id;
      checks.pairedToConfiguredGateway = auth.origin === cfg.origin;
    } catch { checks.pairedToConfiguredGateway = false; }
    for (const [name, path] of Object.entries({ workspace: cfg.workspace, ...(cfg.ripgrep ? { ripgrep: cfg.ripgrep } : {}),
      ...(cfg.chromePath ? { chrome: cfg.chromePath } : {}) })) {
      checks[name] = await stat(path).then(s => ({ exists: true, isDirectory: s.isDirectory() }), () => ({ exists: false }));
    }
    const before = performance.now();
    try {
      const response = await fetch(cfg.origin + '/healthz', { redirect: 'error', signal: AbortSignal.timeout(7000) });
      checks.gateway = { reachable: response.ok, status: response.status, latencyMs: Math.round(performance.now() - before),
        serverDate: response.headers.get('date') };
    } catch { checks.gateway = { reachable: false }; }
  }
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const report = { generatedAt: new Date().toISOString(), version: manifest.version, platform: platform(), architecture: arch(),
    node: process.version, deviceId, gatewayOrigin: cfg?.origin ?? null, desktopCommander: cfg?.desktopCommander ?? null, checks };
  const packageName = 'pizzip';
  const { default: Zip } = await import(packageName);
  const zip = new Zip();
  zip.file('report.json', JSON.stringify(report, null, 2));
  zip.file('report.txt', 'Remote.Command device diagnostics\n' + JSON.stringify(report, null, 2));
  const records = cfg ? await recentClientEvents(cfg.stateDir) : [];
  zip.file('client-events.jsonl', records.map(record => JSON.stringify(record)).join('\n'));
  const output = join(outputDir, 'diagnostics-' + Date.now() + '.zip');
  await writeFile(output, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }), { flag: 'wx', mode: 0o600 });
  console.log('Diagnostics saved:', output);
}
export async function deviceStatus(cfg: AgentConfig) {
  const auth = identity.parse(JSON.parse(await readFile(join(cfg.stateDir, 'identity.json'), 'utf8')));
  console.log(JSON.stringify({ device: auth.id, gateway: cfg.origin, desktopCommander: cfg.desktopCommander,
    platform: platform(), localIdentityPresent: true }, null, 2));
}
export async function agentLock(cfg: AgentConfig) {
  const name = 'proper-lockfile';
  const lock = await import(name);
  return await lock.default.lock(cfg.stateDir, { realpath: true, stale: 20000, update: 5000, retries: 0,
    onCompromised(error: Error) { console.error(errorText(error)); process.kill(process.pid, 'SIGTERM'); } }) as (() => Promise<void>);
}
export function keepAwake(enabled: boolean) {
  if (!enabled || process.platform !== 'darwin') return () => {};
  const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  child.on('error', () => console.error('Could not activate macOS keep-awake mode.'));
  return () => { child.kill('SIGTERM'); };
}
