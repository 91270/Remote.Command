import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { hash, randomPassword, secret, offlineMs, maxActive, maxWaiting, terminal, capability, names, type Op, type Update, type Capability, type Catalog } from './protocol.js';

const day = 86400000;
const dispatchMs = 16 * 60_000;
const SCHEMA_VERSION = 1;
const liveSql = "('dispatched','awaiting_approval','running')";
const outstandingSql = "('queued','dispatched','awaiting_approval','running')";
const doneSql = "('succeeded','failed','denied','cancelled','timed_out','interrupted')";
const operationPlaceholders = names.map(() => '?').join(',');

type DeviceRow = {
  id: string; user_id: string | null; name: string; credential: string; caps: string;
  boot: string | null; seen: number | null; last_seen: number | null; platform: string | null; revoked: number;
};
type TaskRow = {
  id: string; user_id: string | null; device: string; op: Op; args: string; status: string; boot: string | null;
  created: number; changed: number; deadline: number; cancel: number; output: string | null; seq: number;
  mcp_result: string | null; tool_name: string | null;
};
export type RegistrationMode = 'invite_only' | 'open' | 'closed';
export type UserRecord = {
  id: string;
  username: string | null;
  email: string | null;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  displayName: string | null;
  avatarUrl: string | null;
  plan: 'free' | 'pro';
  planExpiresAt: number | null;
  customMonthlyQuota: number | null;
};
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
  lastUsedAt: number | null;
};
export type AuthorizedOAuthClient = {
  clientId: string;
  clientName: string;
  redirectOrigins: string[];
  authorizedAt: string | null;
  lastActiveAt: string | null;
  expiresAt: string;
  activeSessions: number;
};
export type AuthRecord = { digest: string; kind: string; expires: number; data: Record<string, unknown> };

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

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id),
    username: row.username ? String(row.username) : null,
    email: row.email ? String(row.email) : null,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status === 'disabled' ? 'disabled' : 'active',
    displayName: row.display_name ? String(row.display_name) : null,
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    plan: row.plan === 'pro' ? 'pro' : 'free',
    planExpiresAt: row.plan_expires_at ? Number(row.plan_expires_at) : null,
    customMonthlyQuota: row.custom_monthly_quota !== null && row.custom_monthly_quota !== undefined ? Number(row.custom_monthly_quota) : null
  };
}

export class Store {
  readonly db: DatabaseSync;
  private readonly liveSeen = new Map<string, { seen: number; boot: string; platform: string; dirty: boolean }>();
  private readonly liveOAuthActivity = new Map<string, { at: number; flushedAt: number; digest?: string }>();

  private oauthActivityKey(userId: string, clientId: string): string {
    return `${userId}\0${clientId}`;
  }

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, credential TEXT UNIQUE NOT NULL,
        caps TEXT NOT NULL, boot TEXT, seen INTEGER, last_seen INTEGER, platform TEXT, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS retired_boots (device TEXT NOT NULL, boot TEXT NOT NULL, PRIMARY KEY(device, boot));
      CREATE TABLE IF NOT EXISTS invites (digest TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, caps TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, user_id TEXT, device TEXT NOT NULL, op TEXT NOT NULL, args TEXT NOT NULL,
        status TEXT NOT NULL, boot TEXT, created INTEGER NOT NULL, changed INTEGER NOT NULL, deadline INTEGER NOT NULL,
        cancel INTEGER NOT NULL DEFAULT 0, output TEXT, seq INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS task_dispatch ON tasks(device, status, created);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, user_id TEXT, at INTEGER NOT NULL, event TEXT NOT NULL, details TEXT NOT NULL);
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
        token_endpoint_auth_method TEXT NOT NULL, scope TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS registration_invites (code_hash TEXT PRIMARY KEY, code_prefix TEXT NOT NULL, note TEXT,
        max_uses INTEGER NOT NULL DEFAULT 1, used_count INTEGER NOT NULL DEFAULT 0, expires_at INTEGER,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);`);
    this.migrate();
  }

  private ensureColumn(table: string, name: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(column => column.name === name)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      return true;
    }
    return false;
  }

  private migrate() {
    this.tx(() => {
      const currentVersion = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version ?? 0);

      // Idempotent column checks (also supports upgrade tests that drop columns)
      this.ensureColumn('tasks', 'mcp_result', 'TEXT');
      this.ensureColumn('tasks', 'tool_name', 'TEXT');
      this.ensureColumn('tasks', 'background', 'INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('tasks', 'user_id', 'TEXT');

      if (this.ensureColumn('devices', 'last_seen', 'INTEGER')) {
        this.db.exec('UPDATE devices SET last_seen=seen WHERE seen>0');
      }
      this.ensureColumn('devices', 'user_id', 'TEXT');
      this.ensureColumn('invites', 'user_id', 'TEXT');
      this.ensureColumn('audit', 'user_id', 'TEXT');

      this.ensureColumn('users', 'status', "TEXT NOT NULL DEFAULT 'active'");
      this.ensureColumn('users', 'display_name', 'TEXT');
      this.ensureColumn('users', 'avatar_url', 'TEXT');
      this.ensureColumn('users', 'plan', "TEXT NOT NULL DEFAULT 'free'");
      this.ensureColumn('users', 'plan_expires_at', 'INTEGER');
      this.ensureColumn('users', 'custom_monthly_quota', 'INTEGER');
      this.ensureColumn('users', 'last_login_at', 'INTEGER');
      this.ensureColumn('oauth_clients', 'last_used_at', 'INTEGER');

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id, revoked);
        CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, created DESC);
        CREATE INDEX IF NOT EXISTS audit_user ON audit(user_id, id DESC);
      `);

      if (!this.db.prepare("SELECT 1 FROM counters WHERE name='calls'").get()) {
        this.db.exec("INSERT INTO counters SELECT 'calls', count(*) FROM audit WHERE event='task_submitted'");
      }
      if (!this.db.prepare("SELECT 1 FROM system_settings WHERE key='registration_mode'").get()) {
        this.db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES('registration_mode','invite_only',?)").run(Date.now());
      }

      if (currentVersion < SCHEMA_VERSION) {
        const hasLegacyRows = Boolean(
          this.db.prepare('SELECT 1 FROM devices WHERE user_id IS NULL LIMIT 1').get() ||
          this.db.prepare('SELECT 1 FROM tasks WHERE user_id IS NULL LIMIT 1').get() ||
          this.db.prepare('SELECT 1 FROM invites WHERE user_id IS NULL LIMIT 1').get()
        );
        const existingAdmin = this.db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
        let ownerId = existingAdmin?.id;
        if (!ownerId && hasLegacyRows) {
          ownerId = randomUUID();
          this.db.prepare("INSERT INTO users(id,username,email,role,status,plan,password_hash,created_at) VALUES(?,?,NULL,'admin','active','pro',?,?)")
            .run(ownerId, 'admin', hashPassword(randomPassword(8)), Date.now());
        }
        if (ownerId) {
          this.db.prepare('UPDATE devices SET user_id=? WHERE user_id IS NULL').run(ownerId);
          this.db.prepare('UPDATE tasks SET user_id=? WHERE user_id IS NULL').run(ownerId);
          this.db.prepare('UPDATE invites SET user_id=? WHERE user_id IS NULL').run(ownerId);
          this.db.prepare('UPDATE audit SET user_id=? WHERE user_id IS NULL').run(ownerId);
        }
        // Clear legacy auth sessions/tokens that have no userId bound
        this.db.exec("DELETE FROM auth WHERE kind IN ('dashboard','code','access','refresh') AND json_extract(data,'$.userId') IS NULL");
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }
    });
  }

  private resolveOwner(userId?: string): string | null {
    if (userId) return userId;
    const admin = this.db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
    return admin?.id ?? null;
  }

  private deviceSeen(id: string, dbSeen: number | null): number {
    const mem = this.liveSeen.get(id);
    if (mem) return mem.seen;
    return Number(dbSeen ?? 0);
  }

  private deviceLastSeen(id: string, dbLastSeen: number | null): number {
    const mem = this.liveSeen.get(id);
    return Math.max(Number(dbLastSeen ?? 0), mem?.seen ?? 0);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // --- System Settings ---

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM system_settings WHERE key=?').get(key) as { value: string } | undefined;
    return row ? String(row.value) : null;
  }

  setSetting(key: string, value: string, actorUserId?: string): void {
    this.tx(() => {
      this.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
        .run(key, value, Date.now());
      this.audit('system_setting_updated', { key, value }, actorUserId);
    });
  }

  getRegistrationMode(): RegistrationMode {
    const value = this.getSetting('registration_mode');
    if (value === 'open' || value === 'closed' || value === 'invite_only') return value;
    return 'invite_only';
  }

  setRegistrationMode(mode: RegistrationMode, actorUserId?: string): void {
    this.setSetting('registration_mode', mode, actorUserId);
  }

  // --- Users & Identities ---

  userCount(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n);
  }

  hasPasswordAdmin(): boolean {
    return !!this.db.prepare("SELECT 1 FROM users WHERE role='admin' AND password_hash IS NOT NULL LIMIT 1").get();
  }

  findUserById(id: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? mapUser(row) : null;
  }

  findUserByIdentity(provider: string, providerSub: string): UserRecord | null {
    const row = this.db.prepare(
      'SELECT u.* FROM users u JOIN user_identities i ON i.user_id=u.id WHERE i.provider=? AND i.provider_sub=?'
    ).get(provider, providerSub) as Record<string, unknown> | undefined;
    return row ? mapUser(row) : null;
  }

  touchUserLogin(userId: string, profile?: { email?: string | null; displayName?: string | null; avatarUrl?: string | null }) {
    this.tx(() => {
      const now = Date.now();
      this.db.prepare('UPDATE users SET last_login_at=?, display_name=COALESCE(?,display_name), avatar_url=COALESCE(?,avatar_url) WHERE id=?')
        .run(now, profile?.displayName ?? null, profile?.avatarUrl ?? null, userId);
    });
  }

  ensureInitialAdmin(initialPassword?: string): { username: string; password: string; id: string } | null {
    return this.tx(() => {
      const existing = this.db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get();
      if (existing) return null;
      const password = initialPassword ?? randomPassword(8);
      const id = randomUUID();
      this.db.prepare("INSERT INTO users(id,username,email,role,status,plan,password_hash,created_at) VALUES(?,?,NULL,'admin','active','pro',?,?)")
        .run(id, 'admin', hashPassword(password), Date.now());
      this.audit('admin_initialized', { username: 'admin' }, id);
      return { id, username: 'admin', password };
    });
  }

  authenticateUser(username: string, password: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE username=?').get(username) as Record<string, unknown> | undefined;
    if (!row || typeof row.password_hash !== 'string') return null;
    if (row.status === 'disabled') return null;
    if (!verifyPassword(password, row.password_hash)) return null;
    return mapUser(row);
  }

  createGoogleUser(input: {
    sub: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
    adminEmails: Set<string>;
    inviteCode?: string;
  }): { status: 'ok'; user: UserRecord; isFirstAdmin: boolean } | { status: 'invite_required' } | { status: 'closed' } | { status: 'invalid_invite' } | { status: 'admin_email_required' } | { status: 'disabled' } {
    return this.tx(() => {
      const existing = this.findUserByIdentity('google', input.sub);
      if (existing) {
        if (existing.status === 'disabled') return { status: 'disabled' };
        this.db.prepare('UPDATE users SET last_login_at=?, email=?, display_name=COALESCE(?,display_name), avatar_url=COALESCE(?,avatar_url) WHERE id=?')
          .run(Date.now(), input.email, input.displayName, input.avatarUrl, existing.id);
        this.db.prepare('UPDATE user_identities SET email=? WHERE provider=? AND provider_sub=?')
          .run(input.email, 'google', input.sub);
        return { status: 'ok', user: this.findUserById(existing.id)!, isFirstAdmin: false };
      }

      const normalizedEmail = input.email.trim().toLowerCase();
      const totalUsers = this.userCount();
      const isConfiguredAdmin = input.adminEmails.has(normalizedEmail);
      let role: 'admin' | 'user' = 'user';
      let plan: 'free' | 'pro' = 'free';
      let isFirstAdmin = false;

      if (totalUsers === 0) {
        if (input.adminEmails.size > 0 && !isConfiguredAdmin) {
          return { status: 'admin_email_required' };
        }
        role = 'admin';
        plan = 'pro';
        isFirstAdmin = true;
      } else if (isConfiguredAdmin) {
        role = 'admin';
        plan = 'pro';
      } else {
        const mode = this.getRegistrationMode();
        if (mode === 'closed') return { status: 'closed' };
        if (mode === 'invite_only') {
          if (!input.inviteCode) return { status: 'invite_required' };
          const codeHash = hash(input.inviteCode.trim());
          const now = Date.now();
          const consumed = this.db.prepare(
            'UPDATE registration_invites SET used_count=used_count+1 WHERE code_hash=? AND revoked=0 AND used_count<max_uses AND (expires_at IS NULL OR expires_at>?)'
          ).run(codeHash, now);
          if (!consumed.changes) return { status: 'invalid_invite' };
        }
      }

      const userId = randomUUID();
      const now = Date.now();
      this.db.prepare(
        'INSERT INTO users(id,username,email,role,status,display_name,avatar_url,plan,password_hash,created_at,last_login_at) VALUES(?,NULL,?,?,?,?,?,?,NULL,?,?)'
      ).run(userId, normalizedEmail, role, 'active', input.displayName, input.avatarUrl, plan, now, now);
      this.db.prepare(
        'INSERT INTO user_identities(provider,provider_sub,user_id,email,created_at) VALUES(?,?,?,?,?)'
      ).run('google', input.sub, userId, normalizedEmail, now);

      this.audit(isFirstAdmin ? 'first_admin_claimed' : 'user_registered_google', {
        email: normalizedEmail,
        role,
        plan
      }, userId);

      return { status: 'ok', user: this.findUserById(userId)!, isFirstAdmin };
    });
  }

  createRegistrationInvite(createdBy: string, options?: { note?: string; maxUses?: number; expiresInDays?: number }): { code: string; prefix: string; maxUses: number; expiresAt: string | null } {
    return this.tx(() => {
      const code = secret().slice(0, 20);
      const prefix = code.slice(0, 6);
      const maxUses = Math.max(1, Math.min(1000, options?.maxUses ?? 1));
      const now = Date.now();
      const expiresAt = options?.expiresInDays ? now + options.expiresInDays * day : null;
      this.db.prepare(
        'INSERT INTO registration_invites(code_hash,code_prefix,note,max_uses,used_count,expires_at,created_by,created_at,revoked) VALUES(?,?,?,?,0,?,?,?,0)'
      ).run(hash(code), prefix, options?.note ?? null, maxUses, expiresAt, createdBy, now);
      this.audit('registration_invite_created', { prefix, maxUses }, createdBy);
      return { code, prefix, maxUses, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null };
    });
  }

  // --- Auth Table Encapsulation ---

  putAuth(token: string, kind: string, ttlMs: number, data: Record<string, unknown>) {
    this.db.prepare('INSERT INTO auth VALUES(?,?,?,?)').run(hash(token), kind, Date.now() + ttlMs, JSON.stringify(data));
  }

  putAuthByDigest(digest: string, kind: string, ttlMs: number, data: Record<string, unknown>) {
    this.db.prepare('INSERT INTO auth VALUES(?,?,?,?)').run(digest, kind, Date.now() + ttlMs, JSON.stringify(data));
  }

  getAuth(token: string, kind?: string): AuthRecord | undefined {
    const digest = hash(token);
    const row = kind
      ? this.db.prepare('SELECT digest,kind,expires,data FROM auth WHERE digest=? AND kind=? AND expires>?').get(digest, kind, Date.now())
      : this.db.prepare('SELECT digest,kind,expires,data FROM auth WHERE digest=? AND expires>?').get(digest, Date.now());
    if (!row) return undefined;
    return { digest: String(row.digest), kind: String(row.kind), expires: Number(row.expires), data: JSON.parse(String(row.data)) as Record<string, unknown> };
  }

  getAuthByDigest(digest: string, kind?: string): AuthRecord | undefined {
    const row = kind
      ? this.db.prepare('SELECT digest,kind,expires,data FROM auth WHERE digest=? AND kind=? AND expires>?').get(digest, kind, Date.now())
      : this.db.prepare('SELECT digest,kind,expires,data FROM auth WHERE digest=? AND expires>?').get(digest, Date.now());
    if (!row) return undefined;
    return { digest: String(row.digest), kind: String(row.kind), expires: Number(row.expires), data: JSON.parse(String(row.data)) as Record<string, unknown> };
  }

  findAuthByJsonField(kind: string, jsonPath: string, value: string): AuthRecord | undefined {
    const row = this.db.prepare(`SELECT digest,kind,expires,data FROM auth WHERE kind=? AND expires>? AND json_extract(data,?)=?`)
      .get(kind, Date.now(), jsonPath, value);
    if (!row) return undefined;
    return { digest: String(row.digest), kind: String(row.kind), expires: Number(row.expires), data: JSON.parse(String(row.data)) as Record<string, unknown> };
  }

  updateAuthDataByDigest(digest: string, data: Record<string, unknown>) {
    this.db.prepare('UPDATE auth SET data=? WHERE digest=?').run(JSON.stringify(data), digest);
  }

  updateAuthData(token: string, data: Record<string, unknown>) {
    this.updateAuthDataByDigest(hash(token), data);
  }

  setOAuthSelectedDevice(accessToken: string, deviceId: string): boolean {
    return this.tx(() => {
      const record = this.getAuth(accessToken, 'access');
      if (!record) return false;
      const sessionId = typeof record.data.sessionId === 'string' && record.data.sessionId ? record.data.sessionId : null;
      if (sessionId) {
        const rows = this.db.prepare(
          "SELECT digest,data FROM auth WHERE kind IN ('access','refresh') AND expires>? AND json_extract(data,'$.sessionId')=?"
        ).all(Date.now(), sessionId) as { digest: string; data: string }[];
        for (const row of rows) {
          const parsed = JSON.parse(String(row.data)) as Record<string, unknown>;
          this.updateAuthDataByDigest(String(row.digest), { ...parsed, selectedDevice: deviceId });
        }
      } else {
        this.updateAuthDataByDigest(record.digest, { ...record.data, selectedDevice: deviceId });
      }
      return true;
    });
  }

  deleteAuthByDigest(digest: string, kind?: string) {
    if (kind) this.db.prepare('DELETE FROM auth WHERE digest=? AND kind=?').run(digest, kind);
    else this.db.prepare('DELETE FROM auth WHERE digest=?').run(digest);
  }

  deleteAuth(token: string, kind?: string) {
    this.deleteAuthByDigest(hash(token), kind);
  }

  revokeOAuthTokens(userId?: string) {
    this.tx(() => {
      if (userId) {
        this.db.prepare("DELETE FROM auth WHERE kind IN ('access','code','refresh') AND (json_extract(data,'$.userId')=? OR json_extract(data,'$.userId') IS NULL)").run(userId);
        const prefix = `${userId}\0`;
        for (const key of this.liveOAuthActivity.keys()) {
          if (key.startsWith(prefix)) this.liveOAuthActivity.delete(key);
        }
        this.audit('oauth_revoked_all', { scope: 'user' }, userId);
      } else {
        this.db.exec("DELETE FROM auth WHERE kind IN ('access','code','refresh')");
        this.liveOAuthActivity.clear();
        this.audit('oauth_revoked_all', { scope: 'global' });
      }
    });
  }

  revokeAllAuth() {
    this.tx(() => {
      this.db.exec('DELETE FROM auth');
      this.liveOAuthActivity.clear();
      this.audit('oauth_revoked_all', { scope: 'global' });
    });
  }

  // --- Catalog & Audit ---

  catalog(device?: string, userId?: string): Catalog {
    let row: Record<string, unknown> | undefined;
    if (device) {
      row = userId
        ? this.db.prepare('SELECT dc.catalog FROM device_catalog dc JOIN devices d ON d.id=dc.device WHERE dc.device=? AND d.user_id=?').get(device, userId) as Record<string, unknown> | undefined
        : this.db.prepare('SELECT catalog FROM device_catalog WHERE device=?').get(device) as Record<string, unknown> | undefined;
    } else if (userId) {
      row = this.db.prepare('SELECT dc.catalog FROM device_catalog dc JOIN devices d ON d.id=dc.device WHERE d.revoked=0 AND d.user_id=? ORDER BY COALESCE(d.last_seen,d.seen,0) DESC LIMIT 1').get(userId) as Record<string, unknown> | undefined;
    } else {
      row = this.db.prepare('SELECT dc.catalog FROM device_catalog dc JOIN devices d ON d.id=dc.device WHERE d.revoked=0 ORDER BY COALESCE(d.last_seen,d.seen,0) DESC LIMIT 1').get() as Record<string, unknown> | undefined;
    }
    return row ? JSON.parse(String(row.catalog)) as Catalog : { tools: [], resources: [] };
  }

  audit(event: string, fields: object = {}, userId?: string | null): void {
    this.db.prepare('INSERT INTO audit(user_id,at,event,details) VALUES(?,?,?,?)').run(userId ?? null, Date.now(), event, JSON.stringify(fields));
    if (event === 'task_submitted') this.db.exec("UPDATE counters SET value=value+1 WHERE name='calls'");
  }

  recentAudit(limit = 80, userId?: string) {
    const rows = userId
      ? this.db.prepare('SELECT id,user_id,at,event,details FROM audit WHERE user_id=? ORDER BY id DESC LIMIT ?').all(userId, limit)
      : this.db.prepare('SELECT id,user_id,at,event,details FROM audit ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(row => ({
      id: row.id,
      userId: row.user_id ? String(row.user_id) : null,
      at: new Date(Number(row.at)).toISOString(),
      event: row.event,
      details: JSON.parse(String(row.details))
    }));
  }

  totalCalls(userId?: string): number {
    if (userId) {
      const row = this.db.prepare('SELECT count(*) AS n FROM tasks WHERE user_id=?').get(userId) as { n: number };
      return Number(row.n);
    }
    return Number((this.db.prepare("SELECT value FROM counters WHERE name='calls'").get() as { value: number }).value);
  }

  // --- Devices & Pairing ---

  invite(name: string, caps: Capability[], userId?: string): string {
    return this.tx(() => {
      const owner = this.resolveOwner(userId);
      const token = secret();
      this.db.prepare('INSERT INTO invites(digest,user_id,name,caps,expires) VALUES(?,?,?,?,?)')
        .run(hash(token), owner, name, JSON.stringify(caps), Date.now() + 600000);
      this.audit('invite_created', { name, caps }, owner);
      return token;
    });
  }

  pair(token: string, credential: string) {
    return this.tx(() => {
      const invite = this.db.prepare('DELETE FROM invites WHERE digest=? AND expires>? RETURNING user_id,name,caps')
        .get(hash(token), Date.now()) as { user_id: string | null; name: string; caps: string } | undefined;
      if (!invite) return;
      const id = randomUUID();
      const owner = invite.user_id ?? this.resolveOwner();
      this.db.prepare('INSERT INTO devices(id,user_id,name,credential,caps) VALUES(?,?,?,?,?)')
        .run(id, owner, invite.name, hash(credential), invite.caps);
      this.audit('device_paired', { device: id }, owner);
      return { id, name: invite.name, userId: owner };
    });
  }

  createPairedDevice(name: string, credential: string, caps: Capability[], userId?: string) {
    const id = randomUUID();
    const owner = this.resolveOwner(userId);
    this.db.prepare('INSERT INTO devices(id,user_id,name,credential,caps) VALUES(?,?,?,?,?)')
      .run(id, owner, name, hash(credential), JSON.stringify(caps));
    this.audit('device_paired', { device: id }, owner);
    return { id, name, userId: owner };
  }

  devices(userId?: string) {
    const rows = userId
      ? this.db.prepare('SELECT id,user_id,name,caps,seen,last_seen,platform,revoked FROM devices WHERE user_id=? ORDER BY name,id').all(userId)
      : this.db.prepare('SELECT id,user_id,name,caps,seen,last_seen,platform,revoked FROM devices ORDER BY name,id').all();
    const now = Date.now();
    return rows.map(row => {
      const id = String(row.id);
      const seen = this.deviceSeen(id, row.seen ? Number(row.seen) : null);
      const lastSeen = this.deviceLastSeen(id, row.last_seen ? Number(row.last_seen) : null);
      return {
        id,
        userId: row.user_id ? String(row.user_id) : null,
        name: String(row.name),
        capabilities: JSON.parse(String(row.caps)),
        platform: row.platform ? String(row.platform) : null,
        online: !row.revoked && seen > 0 && now - seen < offlineMs,
        lastSeen: lastSeen > 0 ? new Date(lastSeen).toISOString() : null,
        revoked: !!row.revoked
      };
    });
  }

  renameDevice(id: string, name: string, userId?: string): boolean {
    return this.tx(() => {
      const res = userId
        ? this.db.prepare('UPDATE devices SET name=? WHERE id=? AND user_id=? AND revoked=0').run(name, id, userId)
        : this.db.prepare('UPDATE devices SET name=? WHERE id=? AND revoked=0').run(name, id);
      if (!res.changes) return false;
      this.audit('device_renamed', { device: id, name }, userId);
      return true;
    });
  }

  revoke(id: string, userId?: string) {
    return this.tx(() => {
      const row = userId
        ? this.db.prepare('SELECT user_id FROM devices WHERE id=? AND user_id=? AND revoked=0').get(id, userId) as { user_id: string | null } | undefined
        : this.db.prepare('SELECT user_id FROM devices WHERE id=? AND revoked=0').get(id) as { user_id: string | null } | undefined;
      if (!row) return false;
      this.db.prepare('UPDATE devices SET revoked=1, seen=0 WHERE id=?').run(id);
      this.liveSeen.delete(id);
      this.interruptRevokedDeviceTasks(id);
      this.audit('device_revoked', { device: id }, row.user_id ?? userId);
      return true;
    });
  }

  private interruptRevokedDeviceTasks(device: string) {
    for (const t of this.db.prepare(`SELECT id FROM tasks WHERE device=? AND status IN ${outstandingSql}`).all(device)) {
      this.finish(String(t.id), 'interrupted', 'Device revoked. Work already started on the device may require local cleanup.');
    }
  }

  revokeAllDevices(userId?: string) {
    return this.tx(() => {
      const revoked = userId
        ? this.db.prepare('UPDATE devices SET revoked=1, seen=0 WHERE revoked=0 AND user_id=? RETURNING id').all(userId)
        : this.db.prepare('UPDATE devices SET revoked=1, seen=0 WHERE revoked=0 RETURNING id').all();
      for (const row of revoked) {
        const id = String(row.id);
        this.liveSeen.delete(id);
        this.interruptRevokedDeviceTasks(id);
      }
      const invites = userId
        ? this.db.prepare('DELETE FROM invites WHERE user_id=?').run(userId).changes
        : this.db.prepare('DELETE FROM invites').run().changes;
      const pairings = userId
        ? this.db.prepare("DELETE FROM auth WHERE kind='device-enrollment' AND (json_extract(data,'$.userId')=? OR json_extract(data,'$.userId') IS NULL)").run(userId).changes
        : this.db.prepare("DELETE FROM auth WHERE kind='device-enrollment'").run().changes;
      const result = { revokedDevices: revoked.length, invalidatedPairings: Number(invites) + Number(pairings) };
      if (result.revokedDevices || result.invalidatedPairings) this.audit('devices_revoked_all', result, userId);
      return result;
    });
  }

  markOffline(id: string, boot: string | null) {
    if (!boot) return;
    this.tx(() => {
      const dev = this.db.prepare('SELECT user_id, boot FROM devices WHERE id=? AND boot=? AND revoked=0').get(id, boot) as { user_id: string | null; boot: string } | undefined;
      if (!dev) return;
      const mem = this.liveSeen.get(id);
      const flushedLastSeen = mem?.seen ?? 0;
      this.db.prepare('UPDATE devices SET seen=0, last_seen=MAX(COALESCE(last_seen,0),?) WHERE id=? AND boot=? AND revoked=0')
        .run(flushedLastSeen, id, boot);
      this.liveSeen.delete(id);
      const outstanding = this.db.prepare(`SELECT id FROM tasks WHERE device=? AND boot=? AND status IN ${liveSql}`).all(id, boot);
      for (const task of outstanding) {
        this.finish(String(task.id), 'interrupted', 'Agent disconnected before reporting the result.');
      }
      this.audit('device_offline', { device: id }, dev.user_id);
    });
  }

  deviceByToken(token: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE credential=? AND revoked=0').get(hash(token)) as DeviceRow | undefined;
  }

  // --- Tasks ---

  task(id: string, userId?: string): TaskRow | undefined {
    if (userId) {
      return this.db.prepare('SELECT * FROM tasks WHERE id=? AND user_id=?').get(id, userId) as TaskRow | undefined;
    }
    return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow | undefined;
  }

  taskStatusCounts(userId?: string): Record<string, number> {
    const rows = userId
      ? this.db.prepare('SELECT status,count(*) AS count FROM tasks WHERE user_id=? GROUP BY status').all(userId)
      : this.db.prepare('SELECT status,count(*) AS count FROM tasks GROUP BY status').all();
    return Object.fromEntries(rows.map(row => [String(row.status), Number(row.count)]));
  }

  recentTasks(limit = 60, device?: string, userId?: string) {
    let rows: Record<string, unknown>[];
    if (userId && device) {
      rows = this.db.prepare('SELECT * FROM tasks WHERE user_id=? AND device=? ORDER BY created DESC LIMIT ?').all(userId, device, limit) as Record<string, unknown>[];
    } else if (userId) {
      rows = this.db.prepare('SELECT * FROM tasks WHERE user_id=? ORDER BY created DESC LIMIT ?').all(userId, limit) as Record<string, unknown>[];
    } else if (device) {
      rows = this.db.prepare('SELECT * FROM tasks WHERE device=? ORDER BY created DESC LIMIT ?').all(device, limit) as Record<string, unknown>[];
    } else {
      rows = this.db.prepare('SELECT * FROM tasks ORDER BY created DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    }
    return rows.map(row => this.view(row as unknown as TaskRow));
  }

  view(t: TaskRow) {
    return {
      id: t.id, device: t.device, operation: t.op, status: t.status,
      toolName: t.tool_name ?? undefined, cancelRequested: !!t.cancel,
      createdAt: new Date(t.created).toISOString(), updatedAt: new Date(t.changed).toISOString(),
      output: t.output, ...(t.mcp_result ? { result: JSON.parse(t.mcp_result) } : {})
    };
  }

  submit(device: string, op: Op, args: object, userId?: string) {
    return this.tx(() => {
      const dev = userId
        ? this.db.prepare('SELECT * FROM devices WHERE id=? AND user_id=? AND revoked=0').get(device, userId) as DeviceRow | undefined
        : this.db.prepare('SELECT * FROM devices WHERE id=? AND revoked=0').get(device) as DeviceRow | undefined;
      if (!dev) throw new Error('Unknown or revoked device.');
      if (!JSON.parse(dev.caps).includes(capability(op, args as Record<string, unknown>))) throw new Error('Device is not paired for this operation.');
      const seen = this.deviceSeen(device, dev.seen);
      if (!seen || Date.now() - seen >= offlineMs) throw new Error('Device is offline.');
      if (Number((this.db.prepare("SELECT count(*) AS n FROM tasks WHERE device=? AND status='queued'").get(device) as { n: number }).n) >= maxWaiting)
        throw new Error('The device queue is full; wait for outstanding jobs.');
      const id = randomUUID(), now = Date.now(), body = JSON.stringify(args);
      const tool = (args as { tool?: unknown }).tool;
      const nativeName = op === 'dc_call' && typeof tool === 'string' ? tool : op === 'disconnect' ? 'shutdown' : null;
      const owner = dev.user_id ?? userId ?? this.resolveOwner();
      this.db.prepare("INSERT INTO tasks(id,user_id,device,op,args,status,created,changed,deadline,tool_name) VALUES(?,?,?,?,?,'queued',?,?,?,?)")
        .run(id, owner, device, op, body, now, now, now + 900000, nativeName);
      this.audit('task_submitted', { id, device, op, argsDigest: hash(body) }, owner);
      return this.view(this.task(id)!);
    });
  }

  markBackground(id: string) {
    this.db.prepare('UPDATE tasks SET background=1 WHERE id=?').run(id);
  }

  backgroundCalls(limit: number, device?: string, userId?: string) {
    const rows = userId
      ? this.db.prepare(`SELECT id,device,tool_name,status,created,changed FROM tasks
          WHERE background=1 AND user_id=? AND (? IS NULL OR device=?) ORDER BY created DESC, id DESC LIMIT ?`)
          .all(userId, device ?? null, device ?? null, limit)
      : this.db.prepare(`SELECT id,device,tool_name,status,created,changed FROM tasks
          WHERE background=1 AND (? IS NULL OR device=?) ORDER BY created DESC, id DESC LIMIT ?`)
          .all(device ?? null, device ?? null, limit);
    return rows.map(row => ({
      call_id: row.id, device_id: row.device, tool_name: row.tool_name, status: row.status,
      created_at: new Date(Number(row.created)).toISOString(), updated_at: new Date(Number(row.changed)).toISOString()
    }));
  }

  finish(id: string, status: string, output: string, result?: Update['result']) {
    const row = this.db.prepare('SELECT user_id FROM tasks WHERE id=?').get(id) as { user_id: string | null } | undefined;
    this.db.prepare("UPDATE tasks SET status=?,changed=?,output=?,mcp_result=?,args='{}' WHERE id=?")
      .run(status, Date.now(), output, result ? JSON.stringify(result) : null, id);
    this.audit('task_' + status, { id }, row?.user_id);
  }

  cancel(id: string, userId?: string) {
    return this.tx(() => {
      const task = this.task(id, userId);
      if (!task) throw new Error('Unknown task.');
      if (task.status === 'queued') this.finish(id, 'cancelled', 'Cancelled before dispatch.');
      else if (!task.cancel && !terminal.some(s => s === task.status)) {
        this.db.prepare('UPDATE tasks SET cancel=1,changed=? WHERE id=?').run(Date.now(), id);
        this.audit('task_cancel_requested', { id }, task.user_id);
      }
      return this.view(this.task(id)!);
    });
  }

  flushLiveSeen() {
    const dirty: [string, number][] = [];
    for (const [id, entry] of this.liveSeen) {
      if (entry.dirty) {
        dirty.push([id, entry.seen]);
        entry.dirty = false;
      }
    }
    if (!dirty.length) return;
    const stmt = this.db.prepare('UPDATE devices SET seen=?, last_seen=MAX(COALESCE(last_seen,0),?) WHERE id=? AND revoked=0');
    for (const [id, seen] of dirty) stmt.run(seen, seen, id);
  }

  private flushLiveOAuthActivity(now = Date.now()) {
    for (const [key, entry] of this.liveOAuthActivity) {
      if (entry.at > entry.flushedAt) {
        const clientId = key.slice(key.indexOf('\0') + 1);
        this.touchOAuthClient(clientId, entry.at);
        if (entry.digest) {
          const row = this.db.prepare("SELECT data FROM auth WHERE digest=? AND kind='access' AND expires>?").get(entry.digest, now) as { data: string } | undefined;
          if (row) {
            const parsed = JSON.parse(String(row.data)) as Record<string, unknown>;
            if ((Number(parsed.lastActiveAt) || 0) < entry.at) {
              this.updateAuthDataByDigest(entry.digest, { ...parsed, lastActiveAt: entry.at });
            }
          }
        }
        entry.flushedAt = entry.at;
      }
      if (now - entry.at > day) this.liveOAuthActivity.delete(key);
    }
  }

  maintain(taskDays = 7, auditDays = 90, dcrClientDays = 30) {
    this.tx(() => {
      this.flushLiveSeen();
      const now = Date.now();
      this.flushLiveOAuthActivity(now);
      for (const t of this.db.prepare(`SELECT id,status FROM tasks WHERE status NOT IN ${doneSql} AND deadline<?`).all(now)) {
        this.finish(String(t.id), t.status === 'queued' ? 'timed_out' : 'interrupted',
          t.status === 'queued' ? 'Expired before dispatch.' : 'Agent result was not received. Check the device before retrying.');
      }
      this.db.prepare(`DELETE FROM tasks WHERE status IN ${doneSql} AND changed<?`).run(now - taskDays * day);
      this.db.prepare('DELETE FROM audit WHERE at<?').run(now - auditDays * day);
      this.db.prepare('DELETE FROM invites WHERE expires<?').run(now);
      this.db.prepare('DELETE FROM auth WHERE expires<?').run(now);
      this.db.prepare('DELETE FROM oauth_clients WHERE COALESCE(last_used_at, created_at)<?').run(now - dcrClientDays * day);
    });
  }

  sync(device: string, boot: string, platform: string, updates: Update[], catalog?: Catalog, ready = true) {
    const now = Date.now();
    // Fast read-only path: steady heartbeat with no updates, no catalog change, and no pending/active work
    if (ready && updates.length === 0 && !catalog) {
      const mem = this.liveSeen.get(device);
      if (mem && mem.boot === boot && mem.platform === platform) {
        const devCheck = this.db.prepare('SELECT boot,revoked FROM devices WHERE id=?').get(device) as { boot: string | null; revoked: number } | undefined;
        if (devCheck && !devCheck.revoked && devCheck.boot === boot) {
          const hasWork = this.db.prepare(`SELECT 1 FROM tasks WHERE device=? AND status IN ${outstandingSql} LIMIT 1`).get(device);
          if (!hasWork) {
            mem.seen = now;
            mem.dirty = true;
            return { jobs: [], cancel: [], ack: [] };
          }
        }
      }
    }

    return this.tx(() => {
      const dev = this.db.prepare('SELECT * FROM devices WHERE id=? AND revoked=0').get(device) as DeviceRow | undefined;
      if (!dev || this.db.prepare('SELECT 1 FROM retired_boots WHERE device=? AND boot=?').get(device, boot)) return;
      for (const t of this.db.prepare(`SELECT id FROM tasks WHERE device=? AND status IN ${outstandingSql} AND op NOT IN (${operationPlaceholders})`).all(device, ...names))
        this.finish(String(t.id), 'interrupted', 'This operation is unavailable on the current Agent.');
      if (dev.boot && dev.boot !== boot) {
        this.db.prepare('INSERT INTO retired_boots VALUES(?,?)').run(device, dev.boot);
        for (const t of this.db.prepare(`SELECT id FROM tasks WHERE device=? AND status IN ${liveSql}`).all(device))
          this.finish(String(t.id), 'interrupted', 'Agent restarted before reporting the result. Work is not replayed.');
      }
      if (catalog) this.db.prepare('INSERT INTO device_catalog VALUES(?,?) ON CONFLICT(device) DO UPDATE SET catalog=excluded.catalog').run(device, JSON.stringify(catalog));
      this.db.prepare('UPDATE devices SET boot=?,seen=?,last_seen=MAX(COALESCE(last_seen,0),?),platform=? WHERE id=?')
        .run(boot, ready ? now : 0, now, platform, device);
      if (ready) this.liveSeen.set(device, { seen: now, boot, platform, dirty: false });
      else this.liveSeen.delete(device);

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
          if (t.status !== u.status) this.audit('task_' + u.status, { id: u.id }, t.user_id);
          this.db.prepare('UPDATE tasks SET status=?,seq=?,changed=?,output=? WHERE id=?').run(u.status, u.seq, now, u.output ?? null, u.id);
        }
      }
      const active = this.db.prepare(`SELECT * FROM tasks WHERE device=? AND status IN ${liveSql} ORDER BY created`).all(device) as TaskRow[];
      if (!ready) return { jobs: [], cancel: active.filter(task => task.cancel).map(task => task.id), ack };
      const pending = this.db.prepare("SELECT * FROM tasks WHERE device=? AND status='queued' AND deadline>? ORDER BY created LIMIT ?")
        .all(device, now, Math.max(0, maxActive - active.length)) as TaskRow[];
      for (const t of pending) {
        this.db.prepare("UPDATE tasks SET status='dispatched',boot=?,changed=?,deadline=? WHERE id=?").run(boot, now, now + dispatchMs, t.id);
        this.audit('task_dispatched', { id: t.id, device }, t.user_id);
      }
      const jobs = [...active.filter(t => t.status === 'dispatched'), ...pending].map(t => ({ id: t.id, op: t.op, args: JSON.parse(t.args) }));
      return { jobs, cancel: active.filter(t => t.cancel).map(t => t.id), ack };
    });
  }

  // --- OAuth Clients ---

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

  touchOAuthClient(clientId: string, at = Date.now()): void {
    this.db.prepare('UPDATE oauth_clients SET last_used_at=MAX(COALESCE(last_used_at,0),?) WHERE client_id=?').run(at, clientId);
  }

  recordOAuthActivity(userId: string | undefined, clientId: string | undefined, accessDigest?: string, now = Date.now()): void {
    if (!clientId) return;
    if (userId) {
      const key = this.oauthActivityKey(userId, clientId);
      const prev = this.liveOAuthActivity.get(key);
      const shouldFlush = !prev || now - prev.flushedAt >= 60_000;
      const at = Math.max(prev?.at ?? 0, now);
      this.liveOAuthActivity.set(key, {
        at,
        flushedAt: shouldFlush ? at : (prev?.flushedAt ?? 0),
        digest: accessDigest ?? prev?.digest
      });
      if (shouldFlush) {
        this.touchOAuthClient(clientId, at);
        if (accessDigest) {
          const row = this.db.prepare("SELECT data FROM auth WHERE digest=? AND kind='access' AND expires>?").get(accessDigest, now) as { data: string } | undefined;
          if (row) {
            const parsed = JSON.parse(String(row.data)) as Record<string, unknown>;
            if ((Number(parsed.lastActiveAt) || 0) < at) {
              this.updateAuthDataByDigest(accessDigest, { ...parsed, lastActiveAt: at });
            }
          }
        }
      }
      return;
    }
    this.touchOAuthClient(clientId, now);
  }

  listAuthorizedOAuthClients(userId: string): AuthorizedOAuthClient[] {
    const rows = this.db.prepare(
      "SELECT digest, kind, expires, data FROM auth WHERE kind IN ('access','refresh') AND expires>? AND json_extract(data,'$.userId')=?"
    ).all(Date.now(), userId) as { digest: string; kind: string; expires: number; data: string }[];

    type Group = {
      sessions: Set<string>;
      minAuthorizedAt: number | null;
      maxLastActiveAt: number | null;
      maxExpires: number;
      tokenClientName: string | null;
      tokenOrigins: Set<string>;
    };
    const grouped = new Map<string, Group>();

    for (const row of rows) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(row.data)) as Record<string, unknown>;
      } catch {
        continue;
      }
      const clientId = typeof data.clientId === 'string' && data.clientId ? data.clientId : null;
      if (!clientId) continue;

      let group = grouped.get(clientId);
      if (!group) {
        group = {
          sessions: new Set<string>(),
          minAuthorizedAt: null,
          maxLastActiveAt: null,
          maxExpires: 0,
          tokenClientName: null,
          tokenOrigins: new Set<string>()
        };
        grouped.set(clientId, group);
      }

      const sessionKey = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : String(row.digest);
      group.sessions.add(sessionKey);

      const authAt = typeof data.authorizedAt === 'number' && Number.isFinite(data.authorizedAt) ? data.authorizedAt : null;
      if (authAt !== null && (group.minAuthorizedAt === null || authAt < group.minAuthorizedAt)) {
        group.minAuthorizedAt = authAt;
      }

      const activeCandidate = typeof data.lastActiveAt === 'number' && Number.isFinite(data.lastActiveAt)
        ? data.lastActiveAt
        : authAt;
      if (activeCandidate !== null && (group.maxLastActiveAt === null || activeCandidate > group.maxLastActiveAt)) {
        group.maxLastActiveAt = activeCandidate;
      }

      const expires = Number(row.expires);
      if (expires > group.maxExpires) group.maxExpires = expires;

      if (!group.tokenClientName && typeof data.clientName === 'string' && data.clientName.trim()) {
        group.tokenClientName = data.clientName.trim();
      }
      if (typeof data.redirectOrigin === 'string' && data.redirectOrigin) {
        group.tokenOrigins.add(data.redirectOrigin);
      }
    }

    const results: (AuthorizedOAuthClient & { _sortActive: number })[] = [];
    for (const [clientId, group] of grouped) {
      const registered = this.findOAuthClient(clientId);
      const originSet = new Set<string>();
      for (const uri of registered?.redirectUris ?? []) {
        try {
          originSet.add(new URL(uri).origin);
        } catch {
          // Ignore malformed URI in historical client records
        }
      }
      for (const origin of group.tokenOrigins) originSet.add(origin);

      const liveAt = this.liveOAuthActivity.get(this.oauthActivityKey(userId, clientId))?.at ?? 0;
      const lastActiveMs = Math.max(group.maxLastActiveAt ?? 0, group.minAuthorizedAt ?? 0, liveAt);
      const clientName = registered?.clientName || group.tokenClientName || clientId;

      results.push({
        clientId,
        clientName,
        redirectOrigins: [...originSet],
        authorizedAt: group.minAuthorizedAt ? new Date(group.minAuthorizedAt).toISOString() : null,
        lastActiveAt: lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : null,
        expiresAt: new Date(group.maxExpires).toISOString(),
        activeSessions: group.sessions.size,
        _sortActive: lastActiveMs
      });
    }

    results.sort((a, b) =>
      (b._sortActive - a._sortActive) ||
      a.clientName.localeCompare(b.clientName) ||
      a.clientId.localeCompare(b.clientId)
    );
    return results.map(({ _sortActive: _, ...client }) => client);
  }

  revokeOAuthClient(clientId: string, userId: string): number {
    return this.tx(() => {
      let clientName = this.findOAuthClient(clientId)?.clientName ?? null;
      if (!clientName) {
        const meta = this.db.prepare(
          "SELECT json_extract(data,'$.clientName') AS name FROM auth WHERE kind IN ('access','code','refresh') AND json_extract(data,'$.userId')=? AND json_extract(data,'$.clientId')=? AND json_extract(data,'$.clientName') IS NOT NULL LIMIT 1"
        ).get(userId, clientId) as { name: string | null } | undefined;
        if (meta?.name) clientName = String(meta.name);
      }

      const res = this.db.prepare(
        "DELETE FROM auth WHERE kind IN ('access','code','refresh') AND json_extract(data,'$.userId')=? AND json_extract(data,'$.clientId')=?"
      ).run(userId, clientId);
      const revokedTokens = Number(res.changes);
      this.liveOAuthActivity.delete(this.oauthActivityKey(userId, clientId));

      if (revokedTokens > 0) {
        this.audit('oauth_client_revoked', {
          clientId,
          ...(clientName ? { clientName } : {}),
          revokedTokens
        }, userId);
      }
      return revokedTokens;
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
      createdAt: Number(row.created_at),
      lastUsedAt: row.last_used_at ? Number(row.last_used_at) : null
    };
  }
}
