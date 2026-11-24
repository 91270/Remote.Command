import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { hash, randomPassword, secret, offlineMs, maxActive, maxWaiting, terminal, capability, names, type Op, type Update, type Capability, type Catalog } from './protocol.js';

const day = 86400000;
const dispatchMs = 16 * 60_000;
const liveSql = "('dispatched','awaiting_approval','running')";
const outstandingSql = "('queued','dispatched','awaiting_approval','running')";
const doneSql = "('succeeded','failed','denied','cancelled','timed_out','interrupted')";
const operationPlaceholders = names.map(() => '?').join(',');
type Device = { id: string; name: string; credential: string; caps: string; boot: string | null; seen: number | null; platform: string | null; revoked: number };
type Task = { id: string; device: string; op: Op; args: string; status: string; boot: string | null; created: number; changed: number; deadline: number; cancel: number; output: string | null; seq: number; mcp_result: string | null; tool_name: string | null };
export type UserRecord = { id: string; username: string | null; email: string | null; role: 'admin' | 'user' };
export type RegisteredOAuthClient = {
  clientId: string;
  clientSecretHash: string;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string | null;
  createdAt: number;
};

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

export class Store {
  readonly db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, credential TEXT UNIQUE NOT NULL,
        caps TEXT NOT NULL, boot TEXT, seen INTEGER, platform TEXT, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS retired_boots (device TEXT NOT NULL, boot TEXT NOT NULL, PRIMARY KEY(device, boot));
      CREATE TABLE IF NOT EXISTS invites (digest TEXT PRIMARY KEY, name TEXT NOT NULL, caps TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, device TEXT NOT NULL, op TEXT NOT NULL, args TEXT NOT NULL,
        status TEXT NOT NULL, boot TEXT, created INTEGER NOT NULL, changed INTEGER NOT NULL, deadline INTEGER NOT NULL,
        cancel INTEGER NOT NULL DEFAULT 0, output TEXT, seq INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS task_dispatch ON tasks(device, status, created);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, event TEXT NOT NULL, details TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_retention ON audit(at);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth (digest TEXT PRIMARY KEY, kind TEXT NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS auth_expiry ON auth(expires);
      CREATE TABLE IF NOT EXISTS device_catalog (device TEXT PRIMARY KEY, catalog TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE,
        role TEXT NOT NULL DEFAULT 'user', password_hash TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_identities (provider TEXT NOT NULL, provider_sub TEXT NOT NULL,
        user_id TEXT NOT NULL, email TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY(provider, provider_sub), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, client_secret_hash TEXT NOT NULL,
        client_name TEXT, redirect_uris TEXT NOT NULL, grant_types TEXT NOT NULL, response_types TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL, scope TEXT, created_at INTEGER NOT NULL);`);
    this.tx(() => {
      const columns = this.db.prepare('PRAGMA table_info(tasks)').all();
      if (!columns.some(column => column.name === 'mcp_result')) this.db.exec('ALTER TABLE tasks ADD COLUMN mcp_result TEXT');
      if (!columns.some(column => column.name === 'tool_name')) this.db.exec('ALTER TABLE tasks ADD COLUMN tool_name TEXT');
      if (!columns.some(column => column.name === 'background')) this.db.exec('ALTER TABLE tasks ADD COLUMN background INTEGER NOT NULL DEFAULT 0');
      if (!this.db.prepare('PRAGMA table_info(devices)').all().some(column => column.name === 'last_seen')) {
        this.db.exec('ALTER TABLE devices ADD COLUMN last_seen INTEGER; UPDATE devices SET last_seen=seen WHERE seen>0;');
      }
      if (!this.db.prepare("SELECT 1 FROM counters WHERE name='calls'").get())
        this.db.exec("INSERT INTO counters SELECT 'calls', count(*) FROM audit WHERE event='task_submitted'");
    });
  }
  catalog(device?: string): Catalog {
    const row = device
      ? this.db.prepare('SELECT catalog FROM device_catalog WHERE device=?').get(device)
      : this.db.prepare('SELECT catalog FROM device_catalog JOIN devices ON devices.id=device_catalog.device WHERE devices.revoked=0 ORDER BY devices.seen DESC LIMIT 1').get();
    return row ? JSON.parse(String(row.catalog)) as Catalog : { tools: [], resources: [] };
  }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  audit(event: string, fields: object = {}): void {
    this.db.prepare('INSERT INTO audit(at,event,details) VALUES(?,?,?)').run(Date.now(), event, JSON.stringify(fields));
    if (event === 'task_submitted') this.db.exec("UPDATE counters SET value=value+1 WHERE name='calls'");
  }
  totalCalls() { return Number(this.db.prepare("SELECT value FROM counters WHERE name='calls'").get()!.value); }
  invite(name: string, caps: Capability[]): string {
    return this.tx(() => {
      const token = secret();
      this.db.prepare('INSERT INTO invites VALUES(?,?,?,?)').run(hash(token), name, JSON.stringify(caps), Date.now() + 600000);
      this.audit('invite_created', { name, caps });
      return token;
    });
  }
  pair(token: string, credential: string) {
    return this.tx(() => {
      const invite = this.db.prepare('DELETE FROM invites WHERE digest=? AND expires>? RETURNING name,caps').get(hash(token), Date.now());
      if (!invite) return;
      const id = randomUUID();
      this.db.prepare('INSERT INTO devices(id,name,credential,caps) VALUES(?,?,?,?)').run(id, invite.name!, hash(credential), invite.caps!);
      this.audit('device_paired', { device: id });
      return { id, name: invite.name };
    });
  }
  devices() {
    return this.db.prepare('SELECT id,name,caps,seen,last_seen,platform,revoked FROM devices ORDER BY name,id').all().map(row => ({
      id: row.id, name: row.name, capabilities: JSON.parse(String(row.caps)), platform: row.platform,
      online: !row.revoked && !!row.seen && Date.now() - Number(row.seen) < offlineMs,
      lastSeen: row.last_seen ? new Date(Number(row.last_seen)).toISOString() : null, revoked: !!row.revoked
    }));
  }
  revoke(id: string) {
    return this.tx(() => {
      if (!this.db.prepare('UPDATE devices SET revoked=1 WHERE id=? AND revoked=0').run(id).changes) return false;
      this.interruptRevokedDeviceTasks(id);
      this.audit('device_revoked', { device: id });
      return true;
    });
  }
  private interruptRevokedDeviceTasks(device: string) {
    for (const t of this.db.prepare(`SELECT id FROM tasks WHERE device=? AND status IN ${outstandingSql}`).all(device))
      this.finish(String(t.id), 'interrupted', 'Device revoked. Work already started on the device may require local cleanup.');
  }
  revokeAllDevices() {
    return this.tx(() => {
      const revoked = this.db.prepare('UPDATE devices SET revoked=1 WHERE revoked=0 RETURNING id').all();
      for (const row of revoked) this.interruptRevokedDeviceTasks(String(row.id));
      const invites = this.db.prepare('DELETE FROM invites').run().changes;
      const pairings = this.db.prepare("DELETE FROM auth WHERE kind='device-enrollment'").run().changes;
      const result = { revokedDevices: revoked.length, invalidatedPairings: Number(invites) + Number(pairings) };
      if (result.revokedDevices || result.invalidatedPairings) this.audit('devices_revoked_all', result);
      return result;
    });
  }
  markOffline(id: string, boot: string | null) {
    if (!boot) return;
    this.tx(() => {
      const result = this.db.prepare('UPDATE devices SET seen=0 WHERE id=? AND boot=? AND revoked=0').run(id, boot);
      if (!result.changes) return;
      const outstanding = this.db.prepare(`SELECT id FROM tasks WHERE device=? AND boot=? AND status IN ${liveSql}`).all(id, boot);
      for (const task of outstanding) {
        this.finish(String(task.id), 'interrupted', 'Agent disconnected before reporting the result.');
      }
      this.audit('device_offline', { device: id });
    });
  }
  deviceByToken(token: string): Device | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE credential=? AND revoked=0').get(hash(token)) as Device | undefined;
  }
  task(id: string) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Task | undefined; }
  view(t: Task) {
    return { id: t.id, device: t.device, operation: t.op, status: t.status,
      toolName: t.tool_name ?? undefined, cancelRequested: !!t.cancel, createdAt: new Date(t.created).toISOString(),
      updatedAt: new Date(t.changed).toISOString(), output: t.output, ...(t.mcp_result ? { result: JSON.parse(t.mcp_result) } : {}) };
  }
  submit(device: string, op: Op, args: object) {
    return this.tx(() => {
      const dev = this.db.prepare('SELECT * FROM devices WHERE id=? AND revoked=0').get(device) as Device | undefined;
      if (!dev) throw new Error('Unknown or revoked device.');
      if (!JSON.parse(dev.caps).includes(capability(op, args as Record<string, unknown>))) throw new Error('Device is not paired for this operation.');
      if (!dev.seen || Date.now() - dev.seen >= offlineMs) throw new Error('Device is offline.');
      if (Number(this.db.prepare("SELECT count(*) AS n FROM tasks WHERE device=? AND status='queued'").get(device)!.n) >= maxWaiting)
        throw new Error('The device queue is full; wait for outstanding jobs.');
      const id = randomUUID(), now = Date.now(), body = JSON.stringify(args);
      const tool = (args as { tool?: unknown }).tool;
      const nativeName = op === 'dc_call' && typeof tool === 'string' ? tool : op === 'disconnect' ? 'shutdown' : null;
      this.db.prepare("INSERT INTO tasks(id,device,op,args,status,created,changed,deadline,tool_name) VALUES(?,?,?,?,'queued',?,?,?,?)")
        .run(id, device, op, body, now, now, now + 900000, nativeName);
      this.audit('task_submitted', { id, device, op, argsDigest: hash(body) });
      return this.view(this.task(id)!);
    });
  }
  markBackground(id: string) {
    this.db.prepare('UPDATE tasks SET background=1 WHERE id=?').run(id);
  }
  backgroundCalls(limit: number, device?: string) {
    const rows = this.db.prepare(`SELECT id,device,tool_name,status,created,changed FROM tasks
      WHERE background=1 AND (? IS NULL OR device=?) ORDER BY created DESC, id DESC LIMIT ?`)
      .all(device ?? null, device ?? null, limit);
    return rows.map(row => ({ call_id: row.id, device_id: row.device, tool_name: row.tool_name, status: row.status,
      created_at: new Date(Number(row.created)).toISOString(), updated_at: new Date(Number(row.changed)).toISOString() }));
  }
  finish(id: string, status: string, output: string, result?: Update['result']) {
    this.db.prepare("UPDATE tasks SET status=?,changed=?,output=?,mcp_result=?,args='{}' WHERE id=?").run(status, Date.now(), output, result ? JSON.stringify(result) : null, id);
    this.audit('task_' + status, { id });
  }
  cancel(id: string) {
    return this.tx(() => {
      const task = this.task(id);
      if (!task) throw new Error('Unknown task.');
      if (task.status === 'queued') this.finish(id, 'cancelled', 'Cancelled before dispatch.');
      else if (!task.cancel && !terminal.some(s => s === task.status)) {
        this.db.prepare('UPDATE tasks SET cancel=1,changed=? WHERE id=?').run(Date.now(), id);
        this.audit('task_cancel_requested', { id });
      }
      return this.view(this.task(id)!);
    });
  }
  maintain(taskDays = 7, auditDays = 90) {
    this.tx(() => {
      const now = Date.now();
      for (const t of this.db.prepare(`SELECT id,status FROM tasks WHERE status NOT IN ${doneSql} AND deadline<?`).all(now)) {
        this.finish(String(t.id), t.status === 'queued' ? 'timed_out' : 'interrupted',
          t.status === 'queued' ? 'Expired before dispatch.' : 'Agent result was not received. Check the device before retrying.');
      }
      this.db.prepare(`DELETE FROM tasks WHERE status IN ${doneSql} AND changed<?`).run(now - taskDays * day);
      this.db.prepare('DELETE FROM audit WHERE at<?').run(now - auditDays * day);
      this.db.prepare('DELETE FROM invites WHERE expires<?').run(now);
      this.db.prepare('DELETE FROM auth WHERE expires<?').run(now);
    });
  }
  sync(device: string, boot: string, platform: string, updates: Update[], catalog?: Catalog, ready = true) {
    return this.tx(() => {
      const dev = this.db.prepare('SELECT * FROM devices WHERE id=? AND revoked=0').get(device) as Device | undefined;
      if (!dev || this.db.prepare('SELECT 1 FROM retired_boots WHERE device=? AND boot=?').get(device, boot)) return;
      for (const t of this.db.prepare(`SELECT id FROM tasks WHERE device=? AND status IN ${outstandingSql} AND op NOT IN (${operationPlaceholders})`).all(device, ...names))
        this.finish(String(t.id), 'interrupted', 'This operation is unavailable on the current Agent.');
      if (dev.boot && dev.boot !== boot) {
        this.db.prepare('INSERT INTO retired_boots VALUES(?,?)').run(device, dev.boot);
        for (const t of this.db.prepare(`SELECT id FROM tasks WHERE device=? AND status IN ${liveSql}`).all(device))
          this.finish(String(t.id), 'interrupted', 'Agent restarted before reporting the result. Work is not replayed.');
      }
      const now = Date.now();
      if (catalog) this.db.prepare('INSERT INTO device_catalog VALUES(?,?) ON CONFLICT(device) DO UPDATE SET catalog=excluded.catalog').run(device, JSON.stringify(catalog));
      this.db.prepare('UPDATE devices SET boot=?,seen=?,last_seen=MAX(COALESCE(last_seen,0),?),platform=? WHERE id=?')
        .run(boot, ready ? now : 0, now, platform, device);
      const ack: string[] = [];
      for (const u of updates) {
        const t = this.task(u.id);
        if (!t || device !== t.device || boot !== t.boot) { ack.push(u.id); continue; }
        if (terminal.some(s => s === t.status)) { ack.push(u.id); continue; }
        if (u.seq <= t.seq || (t.status === 'running' && u.status === 'awaiting_approval')) continue;
        if (terminal.some(s => s === u.status)) {
          this.finish(u.id, u.status, u.output ?? '', u.result);
          ack.push(u.id);
        } else {
          if (t.status !== u.status) this.audit('task_' + u.status, { id: u.id });
          this.db.prepare('UPDATE tasks SET status=?,seq=?,changed=?,output=? WHERE id=?').run(u.status, u.seq, now, u.output ?? null, u.id);
        }
      }
      const active = this.db.prepare(`SELECT * FROM tasks WHERE device=? AND status IN ${liveSql} ORDER BY created`).all(device) as Task[];
      if (!ready) return { jobs: [], cancel: active.filter(task => task.cancel).map(task => task.id), ack };
      const pending = this.db.prepare("SELECT * FROM tasks WHERE device=? AND status='queued' AND deadline>? ORDER BY created LIMIT ?")
        .all(device, now, Math.max(0, maxActive - active.length)) as Task[];
      for (const t of pending) {
        this.db.prepare("UPDATE tasks SET status='dispatched',boot=?,changed=?,deadline=? WHERE id=?").run(boot, now, now + dispatchMs, t.id);
        this.audit('task_dispatched', { id: t.id, device });
      }
      const jobs = [...active.filter(t => t.status === 'dispatched'), ...pending].map(t => ({ id: t.id, op: t.op, args: JSON.parse(t.args) }));
      return { jobs, cancel: active.filter(t => t.cancel).map(t => t.id), ack };
    });
  }

  ensureInitialAdmin(initialPassword?: string): { username: string; password: string } | null {
    return this.tx(() => {
      const existing = this.db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get();
      if (existing) return null;
      const password = initialPassword ?? randomPassword(8);
      const id = randomUUID();
      this.db.prepare("INSERT INTO users(id,username,email,role,password_hash,created_at) VALUES(?,?,NULL,'admin',?,?)")
        .run(id, 'admin', hashPassword(password), Date.now());
      this.audit('admin_initialized', { username: 'admin' });
      return { username: 'admin', password };
    });
  }

  authenticateUser(username: string, password: string): UserRecord | null {
    const row = this.db.prepare('SELECT id,username,email,role,password_hash FROM users WHERE username=?').get(username);
    if (!row || typeof row.password_hash !== 'string') return null;
    if (!verifyPassword(password, row.password_hash)) return null;
    return {
      id: String(row.id),
      username: row.username ? String(row.username) : null,
      email: row.email ? String(row.email) : null,
      role: row.role === 'admin' ? 'admin' : 'user'
    };
  }

  registerOAuthClient(input: {
    clientName: string | null;
    redirectUris: string[];
    grantTypes: string[];
    responseTypes: string[];
    tokenEndpointAuthMethod: string;
    scope: string | null;
  }): { clientId: string; clientSecret: string; createdAt: number } {
    return this.tx(() => {
      const clientId = 'rcm_' + secret().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
      const clientSecret = secret();
      const createdAt = Date.now();
      this.db.prepare(
        'INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,redirect_uris,grant_types,response_types,token_endpoint_auth_method,scope,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
      ).run(
        clientId,
        hash(clientSecret),
        input.clientName,
        JSON.stringify(input.redirectUris),
        JSON.stringify(input.grantTypes),
        JSON.stringify(input.responseTypes),
        input.tokenEndpointAuthMethod,
        input.scope,
        createdAt
      );
      this.audit('oauth_client_registered', { clientId, clientName: input.clientName, redirectUris: input.redirectUris });
      return { clientId, clientSecret, createdAt };
    });
  }

  findOAuthClient(clientId: string): RegisteredOAuthClient | null {
    const row = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id=?').get(clientId);
    if (!row) return null;
    return {
      clientId: String(row.client_id),
      clientSecretHash: String(row.client_secret_hash),
      clientName: row.client_name ? String(row.client_name) : null,
      redirectUris: JSON.parse(String(row.redirect_uris)) as string[],
      grantTypes: JSON.parse(String(row.grant_types)) as string[],
      responseTypes: JSON.parse(String(row.response_types)) as string[],
      tokenEndpointAuthMethod: String(row.token_endpoint_auth_method),
      scope: row.scope ? String(row.scope) : null,
      createdAt: Number(row.created_at)
    };
  }
}
