import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { hash, secret, offlineMs, maxActive, maxWaiting, terminal, capability, capabilities, names, approvalModes, type ApprovalMode, type Op, type Update, type Capability, type Catalog } from './protocol.js';

const day = 86400000;
const dispatchMs = 16 * 60_000;
const SCHEMA_VERSION = 4;
export const DEFAULT_FREE_MONTHLY_QUOTA = 10000;
export const redeemTiers = ['monthly', 'quarterly', 'yearly', 'lifetime'] as const;
export type RedeemTier = (typeof redeemTiers)[number];
const tierDurationDays: Record<RedeemTier, number | null> = {
  monthly: 30,
  quarterly: 90,
  yearly: 365,
  lifetime: null
};
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function utcMonthKey(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function generateProCode(): string {
  const bytes = randomBytes(15);
  let chars = '';
  for (let i = 0; i < 15; i++) chars += CODE_ALPHABET[bytes[i]! & 31]!;
  return `PRO-${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10, 15)}`;
}
const liveSql = "('dispatched','awaiting_approval','running')";
const outstandingSql = "('queued','dispatched','awaiting_approval','running')";
const doneSql = "('succeeded','failed','denied','cancelled','timed_out','interrupted')";
const failedSql = "('failed','timed_out','interrupted')";
const deniedOrCancelledSql = "('denied','cancelled')";
const operationPlaceholders = names.map(() => '?').join(',');
const normalizeApprovalMode = (raw: unknown): ApprovalMode =>
  typeof raw === 'string' && approvalModes.some(m => m === raw) ? (raw as ApprovalMode) : 'client';
function parseDeviceCaps(raw: unknown): Capability[] | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 3) return undefined;
    return parsed.every(item => typeof item === 'string' && capabilities.some(c => c === item))
      ? (parsed as Capability[])
      : undefined;
  } catch {
    return undefined;
  }
}

type DeviceRow = {
  id: string; user_id: string | null; name: string; credential: string; caps: string;
  approval_mode?: string | null;
  boot: string | null; seen: number | null; last_seen: number | null; platform: string | null; revoked: number;
};
type TaskRow = {
  id: string; user_id: string | null; device: string; op: Op; args: string; status: string; boot: string | null;
  created: number; changed: number; deadline: number; cancel: number; output: string | null; seq: number;
  mcp_result: string | null; tool_name: string | null; duration_ms?: number | null;
  payload_purged?: number | null; payload_purged_at?: number | null;
};
export type MonthlySoftQuotaStatus = {
  limit: number;
  used: number;
  percent: number;
  warningThresholdPercent: 80;
  status: 'ok' | 'warning' | 'exceeded';
  warning: boolean;
  blocking: false;
  resetAt: string;
  message?: string;
};
export type UsageAnalytics = {
  summary: {
    monthCalls: number;
    last30dCalls: number;
    dailyAverageMonth: number;
    terminalCalls30d: number;
    succeededCalls30d: number;
    failedCalls30d: number;
    deniedOrCancelledCalls30d: number;
    successRate30d: number | null;
    avgDurationMs30d: number | null;
    activeTasks: number;
    resetAt: string;
  };
  monthlyTrend: { month: string; label: string; calls: number; succeeded: number; failed: number }[];
  dailyTrend: { date: string; label: string; calls: number; succeeded: number; failed: number }[];
  topTools: { toolName: string; calls: number; succeeded: number; failed: number; successRate: number | null; avgDurationMs: number | null }[];
  deviceDistribution: {
    deviceId: string;
    deviceName: string | null;
    revoked: boolean;
    deleted: boolean;
    calls: number;
    succeeded: number;
    failed: number;
    successRate: number | null;
    avgDurationMs: number | null;
    sharePercent: number;
  }[];
  statusBreakdown30d: Record<string, number>;
  generatedAt: string;
};
export type PlanQuotaStatus = {
  plan: 'free' | 'pro';
  planExpiresAt: string | null;
  month: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  percent: number;
  status: 'unlimited' | 'ok' | 'warning' | 'exceeded';
  warning: boolean;
  exceeded: boolean;
  resetAt: string;
};
export type RedeemHistoryRecord = {
  id: number;
  codePrefix: string;
  tier: RedeemTier;
  durationDays: number | null;
  previousPlan: 'free' | 'pro';
  newPlan: 'free' | 'pro';
  newExpiresAt: string | null;
  redeemedAt: string;
};
export type RedeemResult =
  | { status: 'ok'; tier: RedeemTier; durationDays: number | null; planQuota: PlanQuotaStatus }
  | { status: 'invalid' | 'revoked' | 'expired' | 'exhausted' | 'already_redeemed' | 'already_lifetime' | 'user_not_found' };

export function evaluateMonthlySoftQuota(
  monthlyCalls: number,
  limit: number | null | undefined,
  now = Date.now()
): MonthlySoftQuotaStatus | null {
  if (limit === null || limit === undefined || !Number.isSafeInteger(limit) || limit <= 0) return null;
  const d = new Date(now);
  const resetAt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  const used = Math.max(0, Math.floor(monthlyCalls));
  const percent = Math.round((used / limit) * 100);
  const warning = used / limit >= 0.8;
  const status: MonthlySoftQuotaStatus['status'] = used >= limit ? 'exceeded' : warning ? 'warning' : 'ok';
  const message = status === 'exceeded'
    ? `Monthly call usage (${used}/${limit}, ${percent}%) reached the configured soft quota. Self-hosted calls are not blocked; resets at ${resetAt}.`
    : status === 'warning'
      ? `Monthly call usage (${used}/${limit}, ${percent}%) reached the 80% soft quota warning threshold. Self-hosted calls are not blocked; resets at ${resetAt}.`
      : undefined;
  return {
    limit,
    used,
    percent,
    warningThresholdPercent: 80,
    status,
    warning,
    blocking: false,
    resetAt,
    ...(message ? { message } : {})
  };
}
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
        caps TEXT NOT NULL, approval_mode TEXT NOT NULL DEFAULT 'client', boot TEXT, seen INTEGER, last_seen INTEGER, platform TEXT, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS retired_boots (device TEXT NOT NULL, boot TEXT NOT NULL, PRIMARY KEY(device, boot));
      CREATE TABLE IF NOT EXISTS invites (digest TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, caps TEXT NOT NULL, approval_mode TEXT NOT NULL DEFAULT 'client', expires INTEGER NOT NULL);
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
        role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active', display_name TEXT, avatar_url TEXT,
        plan TEXT NOT NULL DEFAULT 'free', plan_expires_at INTEGER, custom_monthly_quota INTEGER,
        created_at INTEGER NOT NULL, last_login_at INTEGER);
      CREATE TABLE IF NOT EXISTS user_identities (provider TEXT NOT NULL, provider_sub TEXT NOT NULL,
        user_id TEXT NOT NULL, email TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY(provider, provider_sub), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, client_secret_hash TEXT NOT NULL,
        client_name TEXT, redirect_uris TEXT NOT NULL, grant_types TEXT NOT NULL, response_types TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL, scope TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS registration_invites (code_hash TEXT PRIMARY KEY, code_prefix TEXT NOT NULL, note TEXT,
        max_uses INTEGER NOT NULL DEFAULT 1, used_count INTEGER NOT NULL DEFAULT 0, expires_at INTEGER,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS usage_events (task_id TEXT PRIMARY KEY, user_id TEXT, device_id TEXT NOT NULL,
        tool_name TEXT NOT NULL, op TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        finished_at INTEGER, duration_ms INTEGER);
      CREATE TABLE IF NOT EXISTS usage_monthly (user_id TEXT NOT NULL, month TEXT NOT NULL,
        billable_calls INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, month));
      CREATE TABLE IF NOT EXISTS redeem_codes (code_hash TEXT PRIMARY KEY, code_prefix TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'pro', tier TEXT NOT NULL, duration_days INTEGER, note TEXT,
        max_uses INTEGER NOT NULL DEFAULT 1, used_count INTEGER NOT NULL DEFAULT 0, expires_at INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS redeem_redemptions (id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL,
        code_prefix TEXT NOT NULL, user_id TEXT NOT NULL, tier TEXT NOT NULL, duration_days INTEGER,
        previous_plan TEXT NOT NULL, new_plan TEXT NOT NULL, new_expires_at INTEGER, redeemed_at INTEGER NOT NULL,
        UNIQUE(code_hash, user_id));`);
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
      this.ensureColumn('tasks', 'duration_ms', 'INTEGER');
      this.ensureColumn('tasks', 'payload_purged', 'INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('tasks', 'payload_purged_at', 'INTEGER');

      if (this.ensureColumn('devices', 'last_seen', 'INTEGER')) {
        this.db.exec('UPDATE devices SET last_seen=seen WHERE seen>0');
      }
      this.ensureColumn('devices', 'user_id', 'TEXT');
      this.ensureColumn('devices', 'approval_mode', "TEXT NOT NULL DEFAULT 'client'");
      this.ensureColumn('invites', 'user_id', 'TEXT');
      this.ensureColumn('invites', 'approval_mode', "TEXT NOT NULL DEFAULT 'client'");
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
        CREATE INDEX IF NOT EXISTS tasks_payload_purge ON tasks(payload_purged, status, changed);
        CREATE INDEX IF NOT EXISTS audit_user ON audit(user_id, id DESC);
        CREATE INDEX IF NOT EXISTS usage_events_user_created ON usage_events(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS usage_events_created ON usage_events(created_at);
        CREATE INDEX IF NOT EXISTS redeem_redemptions_user ON redeem_redemptions(user_id, redeemed_at DESC);
      `);

      if (!this.db.prepare("SELECT 1 FROM counters WHERE name='calls'").get()) {
        this.db.exec("INSERT INTO counters SELECT 'calls', count(*) FROM audit WHERE event='task_submitted'");
      }
      if (!this.db.prepare("SELECT 1 FROM system_settings WHERE key='registration_mode'").get()) {
        this.db.prepare("INSERT INTO system_settings(key,value,updated_at) VALUES('registration_mode','invite_only',?)").run(Date.now());
      }

      if (currentVersion < 1) {
        const existingAdmin = this.db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
        if (existingAdmin?.id) {
          this.db.prepare('UPDATE devices SET user_id=? WHERE user_id IS NULL').run(existingAdmin.id);
          this.db.prepare('UPDATE tasks SET user_id=? WHERE user_id IS NULL').run(existingAdmin.id);
          this.db.prepare('UPDATE invites SET user_id=? WHERE user_id IS NULL').run(existingAdmin.id);
          this.db.prepare('UPDATE audit SET user_id=? WHERE user_id IS NULL').run(existingAdmin.id);
        }
        // Clear legacy auth sessions/tokens that have no userId bound
        this.db.exec("DELETE FROM auth WHERE kind IN ('dashboard','code','access','refresh') AND json_extract(data,'$.userId') IS NULL");
      }

      if (currentVersion < 2) {
        this.db.exec(`
          UPDATE tasks SET duration_ms = MAX(0, changed - created)
          WHERE status IN ${doneSql} AND duration_ms IS NULL;
          INSERT OR IGNORE INTO usage_events(task_id, user_id, device_id, tool_name, op, status, created_at, finished_at, duration_ms)
          SELECT id, user_id, device, COALESCE(tool_name, op), op, status, created,
            CASE WHEN status IN ${doneSql} THEN changed ELSE NULL END,
            CASE WHEN status IN ${doneSql} THEN COALESCE(duration_ms, MAX(0, changed - created)) ELSE NULL END
          FROM tasks;
        `);
      }

      if (currentVersion < 4) {
        this.db.exec(`
          INSERT OR IGNORE INTO usage_monthly(user_id, month, billable_calls, updated_at)
          SELECT user_id, strftime('%Y-%m', created_at / 1000.0, 'unixepoch') AS month,
            COUNT(*) AS billable_calls, MAX(COALESCE(finished_at, created_at)) AS updated_at
          FROM usage_events
          WHERE user_id IS NOT NULL AND op IN ('dc_call','dc_resource') AND status IN ('succeeded','failed')
          GROUP BY user_id, month;
        `);
      }

      if (currentVersion < SCHEMA_VERSION) {
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

  getDefaultFreeMonthlyQuota(): number {
    const raw = this.getSetting('free_monthly_quota');
    const n = raw ? Number(raw) : NaN;
    return Number.isSafeInteger(n) && n >= 1 ? n : DEFAULT_FREE_MONTHLY_QUOTA;
  }

  getResultTtlMinutes(fallback = 30): number {
    const raw = this.getSetting('result_ttl_minutes');
    if (raw === null || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 && n <= 525600 ? n : fallback;
  }

  getSystemPolicies(fallbackResultTtl = 30): {
    registrationMode: RegistrationMode;
    freeMonthlyQuota: number;
    resultTtlMinutes: number;
  } {
    return {
      registrationMode: this.getRegistrationMode(),
      freeMonthlyQuota: this.getDefaultFreeMonthlyQuota(),
      resultTtlMinutes: this.getResultTtlMinutes(fallbackResultTtl)
    };
  }

  updateSystemPolicies(
    input: { registrationMode?: RegistrationMode; freeMonthlyQuota?: number; resultTtlMinutes?: number },
    actorUserId: string,
    fallbackResultTtl = 30
  ) {
    return this.tx(() => {
      const now = Date.now();
      const upsert = this.db.prepare(
        'INSERT INTO system_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
      );
      if (input.registrationMode !== undefined) upsert.run('registration_mode', input.registrationMode, now);
      if (input.freeMonthlyQuota !== undefined) upsert.run('free_monthly_quota', String(input.freeMonthlyQuota), now);
      if (input.resultTtlMinutes !== undefined) upsert.run('result_ttl_minutes', String(input.resultTtlMinutes), now);
      this.audit('admin_system_policies_updated', input, actorUserId);
      return this.getSystemPolicies(fallbackResultTtl);
    });
  }

  billableMonthlyCalls(userId: string, now = Date.now()): number {
    const row = this.db.prepare('SELECT billable_calls FROM usage_monthly WHERE user_id=? AND month=?')
      .get(userId, utcMonthKey(now)) as { billable_calls: number } | undefined;
    return row ? Number(row.billable_calls) : 0;
  }

  private _downgradeExpiredProUsers(now = Date.now(), userId?: string): number {
    const rows = userId
      ? this.db.prepare("SELECT id, plan_expires_at FROM users WHERE id=? AND plan='pro' AND plan_expires_at IS NOT NULL AND plan_expires_at<=?")
          .all(userId, now) as { id: string; plan_expires_at: number }[]
      : this.db.prepare("SELECT id, plan_expires_at FROM users WHERE plan='pro' AND plan_expires_at IS NOT NULL AND plan_expires_at<=?")
          .all(now) as { id: string; plan_expires_at: number }[];
    let downgraded = 0;
    for (const row of rows) {
      const res = this.db.prepare(
        "UPDATE users SET plan='free', plan_expires_at=NULL WHERE id=? AND plan='pro' AND plan_expires_at IS NOT NULL AND plan_expires_at<=?"
      ).run(row.id, now);
      if (res.changes) {
        downgraded++;
        this.audit('plan_expired_downgraded', {
          previousPlan: 'pro',
          expiredAt: new Date(Number(row.plan_expires_at)).toISOString()
        }, row.id);
      }
    }
    return downgraded;
  }

  downgradeExpiredProUsers(now = Date.now(), userId?: string): number {
    return this.tx(() => this._downgradeExpiredProUsers(now, userId));
  }

  private _buildUserPlanStatus(userId: string, now = Date.now()): PlanQuotaStatus | null {
    const user = this.findUserById(userId);
    if (!user) return null;
    const d = new Date(now);
    const month = utcMonthKey(now);
    const resetAt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
    const used = this.billableMonthlyCalls(userId, now);
    if (user.plan === 'pro') {
      return {
        plan: 'pro',
        planExpiresAt: user.planExpiresAt ? new Date(user.planExpiresAt).toISOString() : null,
        month,
        used,
        limit: null,
        remaining: null,
        percent: 0,
        status: 'unlimited',
        warning: false,
        exceeded: false,
        resetAt
      };
    }
    const limit = user.customMonthlyQuota ?? this.getDefaultFreeMonthlyQuota();
    const remaining = Math.max(0, limit - used);
    const percent = limit > 0 ? Math.round((used / limit) * 100) : 100;
    const exceeded = used >= limit;
    const warning = !exceeded && limit > 0 && used / limit >= 0.8;
    const status: PlanQuotaStatus['status'] = exceeded ? 'exceeded' : warning ? 'warning' : 'ok';
    return {
      plan: 'free',
      planExpiresAt: null,
      month,
      used,
      limit,
      remaining,
      percent,
      status,
      warning,
      exceeded,
      resetAt
    };
  }

  getUserPlanStatus(userId: string, now = Date.now()): PlanQuotaStatus | null {
    const expired = this.db.prepare(
      "SELECT 1 FROM users WHERE id=? AND plan='pro' AND plan_expires_at IS NOT NULL AND plan_expires_at<=?"
    ).get(userId, now);
    if (expired) {
      this.tx(() => this._downgradeExpiredProUsers(now, userId));
    }
    return this._buildUserPlanStatus(userId, now);
  }

  grantUserPlan(userId: string, input: {
    plan: 'free' | 'pro';
    durationDays?: number | null;
    source: string;
    externalRef?: string | null;
    actorUserId?: string;
    now?: number;
  }): PlanQuotaStatus | null {
    return this.tx(() => {
      const now = input.now ?? Date.now();
      this._downgradeExpiredProUsers(now, userId);
      const user = this.findUserById(userId);
      if (!user) return null;
      let newExpiresAt: number | null = null;
      if (input.plan === 'pro' && input.durationDays !== null && input.durationDays !== undefined) {
        const base = user.plan === 'pro' && user.planExpiresAt ? Math.max(now, user.planExpiresAt) : now;
        newExpiresAt = base + input.durationDays * day;
      }
      this.db.prepare('UPDATE users SET plan=?, plan_expires_at=? WHERE id=?').run(input.plan, newExpiresAt, userId);
      this.audit('plan_updated', {
        source: input.source,
        previousPlan: user.plan,
        newPlan: input.plan,
        durationDays: input.durationDays ?? null,
        newExpiresAt: newExpiresAt ? new Date(newExpiresAt).toISOString() : null,
        ...(input.externalRef ? { externalRef: input.externalRef } : {}),
        ...(input.actorUserId ? { actorUserId: input.actorUserId } : {})
      }, userId);
      return this._buildUserPlanStatus(userId, now);
    });
  }

  createRedeemCode(createdBy: string, options: {
    tier: RedeemTier;
    maxUses?: number;
    expiresInDays?: number;
    note?: string;
    now?: number;
  }): { code: string; prefix: string; tier: RedeemTier; durationDays: number | null; maxUses: number; expiresAt: string | null } {
    return this.tx(() => {
      const now = options.now ?? Date.now();
      const code = generateProCode();
      const prefix = code.slice(0, 9);
      const durationDays = tierDurationDays[options.tier];
      const maxUses = Math.max(1, Math.min(10000, options.maxUses ?? 1));
      const expiresAt = options.expiresInDays ? now + options.expiresInDays * day : null;
      this.db.prepare(
        'INSERT INTO redeem_codes(code_hash,code_prefix,plan,tier,duration_days,note,max_uses,used_count,expires_at,revoked,created_by,created_at) VALUES(?,?,?,?,?,?,?,0,?,0,?,?)'
      ).run(hash(code), prefix, 'pro', options.tier, durationDays, options.note ?? null, maxUses, expiresAt, createdBy, now);
      this.audit('redeem_code_created', { prefix, tier: options.tier, durationDays, maxUses }, createdBy);
      return {
        code,
        prefix,
        tier: options.tier,
        durationDays,
        maxUses,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
      };
    });
  }

  revokeRedeemCode(codeHash: string, actorUserId?: string): boolean {
    return this.tx(() => {
      const row = this.db.prepare('SELECT code_prefix FROM redeem_codes WHERE code_hash=? AND revoked=0')
        .get(codeHash) as { code_prefix: string } | undefined;
      if (!row) return false;
      this.db.prepare('UPDATE redeem_codes SET revoked=1 WHERE code_hash=?').run(codeHash);
      this.audit('redeem_code_revoked', { prefix: row.code_prefix }, actorUserId);
      return true;
    });
  }

  redeemProCode(userId: string, rawCode: string, now = Date.now()): RedeemResult {
    return this.tx(() => {
      this._downgradeExpiredProUsers(now, userId);
      const user = this.findUserById(userId);
      if (!user) return { status: 'user_not_found' };

      const normalized = rawCode.trim().toUpperCase();
      if (!normalized) return { status: 'invalid' };
      const codeHash = hash(normalized);

      const codeRow = this.db.prepare('SELECT * FROM redeem_codes WHERE code_hash=?')
        .get(codeHash) as {
          code_hash: string; code_prefix: string; tier: string; duration_days: number | null;
          max_uses: number; used_count: number; expires_at: number | null; revoked: number;
        } | undefined;
      if (!codeRow) return { status: 'invalid' };

      const already = this.db.prepare('SELECT 1 FROM redeem_redemptions WHERE code_hash=? AND user_id=?')
        .get(codeHash, userId);
      if (already) return { status: 'already_redeemed' };

      if (codeRow.revoked) return { status: 'revoked' };
      if (codeRow.expires_at !== null && Number(codeRow.expires_at) <= now) return { status: 'expired' };
      if (Number(codeRow.used_count) >= Number(codeRow.max_uses)) return { status: 'exhausted' };

      const tier = redeemTiers.some(t => t === codeRow.tier) ? (codeRow.tier as RedeemTier) : 'monthly';
      const durationDays = codeRow.duration_days !== null && codeRow.duration_days !== undefined
        ? Number(codeRow.duration_days)
        : null;

      if (user.plan === 'pro' && user.planExpiresAt === null && durationDays !== null) {
        return { status: 'already_lifetime' };
      }

      const claimed = this.db.prepare(
        'UPDATE redeem_codes SET used_count=used_count+1 WHERE code_hash=? AND revoked=0 AND used_count<max_uses AND (expires_at IS NULL OR expires_at>?)'
      ).run(codeHash, now);
      if (!claimed.changes) return { status: 'exhausted' };

      const newExpiresAt = durationDays === null
        ? null
        : Math.max(now, user.plan === 'pro' && user.planExpiresAt ? user.planExpiresAt : now) + durationDays * day;

      this.db.prepare("UPDATE users SET plan='pro', plan_expires_at=? WHERE id=?").run(newExpiresAt, userId);
      this.db.prepare(
        'INSERT INTO redeem_redemptions(code_hash,code_prefix,user_id,tier,duration_days,previous_plan,new_plan,new_expires_at,redeemed_at) VALUES(?,?,?,?,?,?,?,?,?)'
      ).run(codeHash, codeRow.code_prefix, userId, tier, durationDays, user.plan, 'pro', newExpiresAt, now);

      this.audit('redeem_code_redeemed', {
        prefix: codeRow.code_prefix,
        tier,
        durationDays,
        previousPlan: user.plan,
        newExpiresAt: newExpiresAt ? new Date(newExpiresAt).toISOString() : null
      }, userId);

      return {
        status: 'ok',
        tier,
        durationDays,
        planQuota: this._buildUserPlanStatus(userId, now)!
      };
    });
  }

  userRedemptions(userId: string, limit = 20): RedeemHistoryRecord[] {
    const rows = this.db.prepare(
      'SELECT id,code_prefix,tier,duration_days,previous_plan,new_plan,new_expires_at,redeemed_at FROM redeem_redemptions WHERE user_id=? ORDER BY redeemed_at DESC, id DESC LIMIT ?'
    ).all(userId, limit) as Record<string, unknown>[];
    return rows.map(r => ({
      id: Number(r.id),
      codePrefix: String(r.code_prefix),
      tier: (redeemTiers.some(t => t === r.tier) ? r.tier : 'monthly') as RedeemTier,
      durationDays: r.duration_days !== null && r.duration_days !== undefined ? Number(r.duration_days) : null,
      previousPlan: r.previous_plan === 'pro' ? 'pro' : 'free',
      newPlan: r.new_plan === 'pro' ? 'pro' : 'free',
      newExpiresAt: r.new_expires_at !== null && r.new_expires_at !== undefined ? new Date(Number(r.new_expires_at)).toISOString() : null,
      redeemedAt: new Date(Number(r.redeemed_at)).toISOString()
    }));
  }

  // --- Users & Identities ---

  userCount(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n);
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

  userAuthMethods(userId: string): 'google'[] {
    const identities = this.db.prepare('SELECT DISTINCT provider FROM user_identities WHERE user_id=?')
      .all(userId) as { provider: string }[];
    return identities.some(row => row.provider === 'google') ? ['google'] : [];
  }

  touchUserLogin(userId: string, profile?: { email?: string | null; displayName?: string | null; avatarUrl?: string | null }) {
    this.tx(() => {
      const now = Date.now();
      this.db.prepare('UPDATE users SET last_login_at=?, display_name=COALESCE(?,display_name), avatar_url=COALESCE(?,avatar_url) WHERE id=?')
        .run(now, profile?.displayName ?? null, profile?.avatarUrl ?? null, userId);
    });
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
        'INSERT INTO users(id,username,email,role,status,display_name,avatar_url,plan,created_at,last_login_at) VALUES(?,NULL,?,?,?,?,?,?,?,?)'
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

  monthlyCalls(userId?: string, now = Date.now()): number {
    const d = new Date(now);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const row = userId
      ? this.db.prepare('SELECT count(*) AS n FROM usage_events WHERE user_id=? AND created_at>=?').get(userId, monthStart) as { n: number }
      : this.db.prepare('SELECT count(*) AS n FROM usage_events WHERE created_at>=?').get(monthStart) as { n: number };
    return Number(row.n);
  }

  usageAnalytics(userId?: string, options?: { now?: number; windowDays?: number; topLimit?: number }): UsageAnalytics {
    const now = options?.now ?? Date.now();
    const windowDays = Math.max(1, Math.min(90, options?.windowDays ?? 30));
    const topLimit = Math.max(1, Math.min(30, options?.topLimit ?? 10));
    const d = new Date(now);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const nextMonthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const sinceWindow = now - windowDays * day;
    const sixMonthsStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 5, 1);
    const dailyStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (windowDays - 1));

    const userFilter = userId ? 'user_id=? AND ' : '';
    const userArgs = userId ? [userId] : [];
    const monthCalls = this.monthlyCalls(userId, now);

    const agg = this.db.prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ${doneSql} THEN 1 ELSE 0 END) AS terminal_count,
        SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded_count,
        SUM(CASE WHEN status IN ${failedSql} THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN status IN ${deniedOrCancelledSql} THEN 1 ELSE 0 END) AS denied_cancelled_count,
        AVG(CASE WHEN status IN ${doneSql} AND duration_ms IS NOT NULL THEN duration_ms ELSE NULL END) AS avg_duration
      FROM usage_events
      WHERE ${userFilter}created_at>=?`
    ).get(...userArgs, sinceWindow) as {
      total: number;
      terminal_count: number | null;
      succeeded_count: number | null;
      failed_count: number | null;
      denied_cancelled_count: number | null;
      avg_duration: number | null;
    };

    const last30dCalls = Number(agg.total ?? 0);
    const terminalCalls30d = Number(agg.terminal_count ?? 0);
    const succeededCalls30d = Number(agg.succeeded_count ?? 0);
    const failedCalls30d = Number(agg.failed_count ?? 0);
    const deniedOrCancelledCalls30d = Number(agg.denied_cancelled_count ?? 0);
    const successRate30d = terminalCalls30d > 0
      ? Number(((succeededCalls30d / terminalCalls30d) * 100).toFixed(1))
      : null;
    const avgDurationMs30d = agg.avg_duration !== null && agg.avg_duration !== undefined
      ? Math.round(Number(agg.avg_duration))
      : null;

    const taskCounts = this.taskStatusCounts(userId);
    const activeTasks = Object.entries(taskCounts)
      .filter(([status]) => !terminal.some(value => value === status))
      .reduce((sum, [, count]) => sum + count, 0);

    const monthlyRows = this.db.prepare(
      `SELECT
        strftime('%Y-%m', created_at / 1000.0, 'unixepoch') AS bucket,
        COUNT(*) AS calls,
        SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status IN ${failedSql} THEN 1 ELSE 0 END) AS failed
      FROM usage_events
      WHERE ${userFilter}created_at>=?
      GROUP BY bucket`
    ).all(...userArgs, sixMonthsStart) as { bucket: string; calls: number; succeeded: number | null; failed: number | null }[];
    const monthlyMap = new Map(monthlyRows.map(r => [String(r.bucket), r]));
    const monthlyTrend: UsageAnalytics['monthlyTrend'] = [];
    for (let i = 5; i >= 0; i--) {
      const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
      const key = `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
      const hit = monthlyMap.get(key);
      monthlyTrend.push({
        month: key,
        label: `${m.getUTCMonth() + 1}月`,
        calls: hit ? Number(hit.calls) : 0,
        succeeded: hit ? Number(hit.succeeded ?? 0) : 0,
        failed: hit ? Number(hit.failed ?? 0) : 0
      });
    }

    const dailyRows = this.db.prepare(
      `SELECT
        strftime('%Y-%m-%d', created_at / 1000.0, 'unixepoch') AS bucket,
        COUNT(*) AS calls,
        SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status IN ${failedSql} THEN 1 ELSE 0 END) AS failed
      FROM usage_events
      WHERE ${userFilter}created_at>=?
      GROUP BY bucket`
    ).all(...userArgs, dailyStart) as { bucket: string; calls: number; succeeded: number | null; failed: number | null }[];
    const dailyMap = new Map(dailyRows.map(r => [String(r.bucket), r]));
    const dailyTrend: UsageAnalytics['dailyTrend'] = [];
    for (let i = windowDays - 1; i >= 0; i--) {
      const dayDate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - i));
      const key = `${dayDate.getUTCFullYear()}-${String(dayDate.getUTCMonth() + 1).padStart(2, '0')}-${String(dayDate.getUTCDate()).padStart(2, '0')}`;
      const hit = dailyMap.get(key);
      dailyTrend.push({
        date: key,
        label: `${dayDate.getUTCMonth() + 1}/${dayDate.getUTCDate()}`,
        calls: hit ? Number(hit.calls) : 0,
        succeeded: hit ? Number(hit.succeeded ?? 0) : 0,
        failed: hit ? Number(hit.failed ?? 0) : 0
      });
    }

    const toolRows = this.db.prepare(
      `SELECT
        tool_name,
        COUNT(*) AS calls,
        SUM(CASE WHEN status IN ${doneSql} THEN 1 ELSE 0 END) AS terminal_count,
        SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN status IN ${failedSql} THEN 1 ELSE 0 END) AS failed,
        AVG(CASE WHEN status IN ${doneSql} AND duration_ms IS NOT NULL THEN duration_ms ELSE NULL END) AS avg_duration
      FROM usage_events
      WHERE ${userFilter}created_at>=?
      GROUP BY tool_name
      ORDER BY calls DESC, tool_name ASC
      LIMIT ?`
    ).all(...userArgs, sinceWindow, topLimit) as {
      tool_name: string; calls: number; terminal_count: number | null; succeeded: number | null; failed: number | null; avg_duration: number | null;
    }[];
    const topTools: UsageAnalytics['topTools'] = toolRows.map(r => {
      const term = Number(r.terminal_count ?? 0);
      const succ = Number(r.succeeded ?? 0);
      return {
        toolName: String(r.tool_name),
        calls: Number(r.calls),
        succeeded: succ,
        failed: Number(r.failed ?? 0),
        successRate: term > 0 ? Number(((succ / term) * 100).toFixed(1)) : null,
        avgDurationMs: r.avg_duration !== null && r.avg_duration !== undefined ? Math.round(Number(r.avg_duration)) : null
      };
    });

    const eUserFilter = userId ? 'e.user_id=? AND ' : '';
    const deviceRows = this.db.prepare(
      `SELECT
        e.device_id AS device_id,
        d.name AS device_name,
        COALESCE(d.revoked, 0) AS revoked,
        (d.id IS NULL) AS deleted,
        COUNT(*) AS calls,
        SUM(CASE WHEN e.status IN ${doneSql} THEN 1 ELSE 0 END) AS terminal_count,
        SUM(CASE WHEN e.status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN e.status IN ${failedSql} THEN 1 ELSE 0 END) AS failed,
        AVG(CASE WHEN e.status IN ${doneSql} AND e.duration_ms IS NOT NULL THEN e.duration_ms ELSE NULL END) AS avg_duration
      FROM usage_events e
      LEFT JOIN devices d ON d.id = e.device_id
      WHERE ${eUserFilter}e.created_at>=?
      GROUP BY e.device_id
      ORDER BY calls DESC, e.device_id ASC`
    ).all(...userArgs, sinceWindow) as {
      device_id: string; device_name: string | null; revoked: number; deleted: number;
      calls: number; terminal_count: number | null; succeeded: number | null; failed: number | null; avg_duration: number | null;
    }[];
    const deviceDistribution: UsageAnalytics['deviceDistribution'] = deviceRows.map(r => {
      const calls = Number(r.calls);
      const term = Number(r.terminal_count ?? 0);
      const succ = Number(r.succeeded ?? 0);
      return {
        deviceId: String(r.device_id),
        deviceName: r.device_name ? String(r.device_name) : null,
        revoked: Boolean(r.revoked),
        deleted: Boolean(r.deleted),
        calls,
        succeeded: succ,
        failed: Number(r.failed ?? 0),
        successRate: term > 0 ? Number(((succ / term) * 100).toFixed(1)) : null,
        avgDurationMs: r.avg_duration !== null && r.avg_duration !== undefined ? Math.round(Number(r.avg_duration)) : null,
        sharePercent: last30dCalls > 0 ? Number(((calls / last30dCalls) * 100).toFixed(1)) : 0
      };
    });

    const statusRows = this.db.prepare(
      `SELECT status, COUNT(*) AS count FROM usage_events WHERE ${userFilter}created_at>=? GROUP BY status`
    ).all(...userArgs, sinceWindow) as { status: string; count: number }[];
    const statusBreakdown30d = Object.fromEntries(statusRows.map(r => [String(r.status), Number(r.count)]));

    return {
      summary: {
        monthCalls,
        last30dCalls,
        dailyAverageMonth: Number((monthCalls / Math.max(1, d.getUTCDate())).toFixed(1)),
        terminalCalls30d,
        succeededCalls30d,
        failedCalls30d,
        deniedOrCancelledCalls30d,
        successRate30d,
        avgDurationMs30d,
        activeTasks,
        resetAt: new Date(nextMonthStart).toISOString()
      },
      monthlyTrend,
      dailyTrend,
      topTools,
      deviceDistribution,
      statusBreakdown30d,
      generatedAt: new Date(now).toISOString()
    };
  }

  // --- Devices & Pairing ---

  invite(name: string, caps: Capability[], userId?: string, approvalMode: ApprovalMode = 'client'): string {
    return this.tx(() => {
      const owner = this.resolveOwner(userId);
      const token = secret();
      this.db.prepare('INSERT INTO invites(digest,user_id,name,caps,approval_mode,expires) VALUES(?,?,?,?,?,?)')
        .run(hash(token), owner, name, JSON.stringify(caps), approvalMode, Date.now() + 600000);
      this.audit('invite_created', { name, caps, approvalMode }, owner);
      return token;
    });
  }

  pair(token: string, credential: string) {
    return this.tx(() => {
      const invite = this.db.prepare('DELETE FROM invites WHERE digest=? AND expires>? RETURNING user_id,name,caps,approval_mode')
        .get(hash(token), Date.now()) as { user_id: string | null; name: string; caps: string; approval_mode?: string | null } | undefined;
      if (!invite) return;
      const id = randomUUID();
      const owner = invite.user_id ?? this.resolveOwner();
      const approvalMode = normalizeApprovalMode(invite.approval_mode);
      this.db.prepare('INSERT INTO devices(id,user_id,name,credential,caps,approval_mode) VALUES(?,?,?,?,?,?)')
        .run(id, owner, invite.name, hash(credential), invite.caps, approvalMode);
      this.audit('device_paired', { device: id, approvalMode }, owner);
      return { id, name: invite.name, userId: owner, approvalMode };
    });
  }

  createPairedDevice(name: string, credential: string, caps: Capability[], userId?: string, approvalMode: ApprovalMode = 'client') {
    const id = randomUUID();
    const owner = this.resolveOwner(userId);
    this.db.prepare('INSERT INTO devices(id,user_id,name,credential,caps,approval_mode) VALUES(?,?,?,?,?,?)')
      .run(id, owner, name, hash(credential), JSON.stringify(caps), approvalMode);
    this.audit('device_paired', { device: id, approvalMode }, owner);
    return { id, name, userId: owner, approvalMode };
  }

  devices(userId?: string) {
    const rows = userId
      ? this.db.prepare('SELECT id,user_id,name,caps,approval_mode,seen,last_seen,platform,revoked FROM devices WHERE user_id=? ORDER BY name,id').all(userId)
      : this.db.prepare('SELECT id,user_id,name,caps,approval_mode,seen,last_seen,platform,revoked FROM devices ORDER BY name,id').all();
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
        approvalMode: normalizeApprovalMode(row.approval_mode),
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

  setDeviceApprovalMode(id: string, approvalMode: ApprovalMode, userId?: string): boolean {
    return this.tx(() => {
      const res = userId
        ? this.db.prepare('UPDATE devices SET approval_mode=? WHERE id=? AND user_id=? AND revoked=0').run(approvalMode, id, userId)
        : this.db.prepare('UPDATE devices SET approval_mode=? WHERE id=? AND revoked=0').run(approvalMode, id);
      if (!res.changes) return false;
      this.audit('device_approval_mode_updated', { device: id, approvalMode }, userId);
      return true;
    });
  }

  setDevicePolicy(id: string, caps: Capability[], approvalMode: ApprovalMode, userId?: string): boolean {
    return this.tx(() => {
      const encodedCaps = JSON.stringify(caps);
      const res = userId
        ? this.db.prepare('UPDATE devices SET caps=?, approval_mode=? WHERE id=? AND user_id=? AND revoked=0').run(encodedCaps, approvalMode, id, userId)
        : this.db.prepare('UPDATE devices SET caps=?, approval_mode=? WHERE id=? AND revoked=0').run(encodedCaps, approvalMode, id);
      if (!res.changes) return false;
      this.audit('device_policy_updated', { device: id, capabilities: caps, approvalMode }, userId);
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

  private purgeDeviceRecord(id: string) {
    this.db.prepare('DELETE FROM retired_boots WHERE device=?').run(id);
    this.db.prepare('DELETE FROM device_catalog WHERE device=?').run(id);
    this.db.prepare('DELETE FROM devices WHERE id=? AND revoked=1').run(id);
    this.liveSeen.delete(id);
  }

  deleteRevokedDevice(id: string, userId?: string): boolean {
    return this.tx(() => {
      const row = userId
        ? this.db.prepare('SELECT user_id, name FROM devices WHERE id=? AND user_id=? AND revoked=1').get(id, userId) as { user_id: string | null; name: string } | undefined
        : this.db.prepare('SELECT user_id, name FROM devices WHERE id=? AND revoked=1').get(id) as { user_id: string | null; name: string } | undefined;
      if (!row) return false;
      this.purgeDeviceRecord(id);
      this.audit('device_deleted', { device: id, name: row.name }, row.user_id ?? userId);
      return true;
    });
  }

  clearRevokedDevices(userId?: string): { deletedDevices: number } {
    return this.tx(() => {
      const rows = userId
        ? this.db.prepare('SELECT id FROM devices WHERE revoked=1 AND user_id=?').all(userId)
        : this.db.prepare('SELECT id FROM devices WHERE revoked=1').all();
      for (const row of rows) {
        this.purgeDeviceRecord(String(row.id));
      }
      const deletedDevices = rows.length;
      if (deletedDevices) this.audit('devices_revoked_cleared', { deletedDevices }, userId);
      return { deletedDevices };
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
    const payloadPurged = !!t.payload_purged;
    return {
      id: t.id, device: t.device, operation: t.op, status: t.status,
      toolName: t.tool_name ?? undefined, cancelRequested: !!t.cancel,
      createdAt: new Date(t.created).toISOString(), updatedAt: new Date(t.changed).toISOString(),
      durationMs: t.duration_ms !== undefined && t.duration_ms !== null ? Number(t.duration_ms) : null,
      payloadPurged,
      ...(t.payload_purged_at ? { payloadPurgedAt: new Date(Number(t.payload_purged_at)).toISOString() } : {}),
      output: payloadPurged ? null : t.output,
      ...(!payloadPurged && t.mcp_result ? { result: JSON.parse(t.mcp_result) } : {})
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
      this.db.prepare("INSERT INTO usage_events(task_id,user_id,device_id,tool_name,op,status,created_at) VALUES(?,?,?,?,?,'queued',?)")
        .run(id, owner, device, nativeName ?? op, op, now);
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
    const row = this.db.prepare('SELECT user_id, op, status, created FROM tasks WHERE id=?')
      .get(id) as { user_id: string | null; op: Op; status: string; created: number } | undefined;
    const now = Date.now();
    const durationMs = row ? Math.max(0, now - Number(row.created)) : null;
    this.db.prepare("UPDATE tasks SET status=?,changed=?,duration_ms=?,output=?,mcp_result=?,args='{}' WHERE id=?")
      .run(status, now, durationMs, output, result ? JSON.stringify(result) : null, id);
    this.db.prepare('UPDATE usage_events SET status=?,finished_at=?,duration_ms=? WHERE task_id=?')
      .run(status, now, durationMs, id);
    if (
      row?.user_id &&
      !terminal.some(s => s === row.status) &&
      (row.op === 'dc_call' || row.op === 'dc_resource') &&
      (status === 'succeeded' || status === 'failed')
    ) {
      this.db.prepare(
        'INSERT INTO usage_monthly(user_id,month,billable_calls,updated_at) VALUES(?,?,1,?) ON CONFLICT(user_id,month) DO UPDATE SET billable_calls=billable_calls+1, updated_at=excluded.updated_at'
      ).run(row.user_id, utcMonthKey(now), now);
    }
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

  purgeExpiredPayloads(resultTtlMinutes = 30, now = Date.now()): number {
    if (!Number.isFinite(resultTtlMinutes) || resultTtlMinutes <= 0) return 0;
    const cutoff = now - resultTtlMinutes * 60_000;
    const res = this.db.prepare(
      `UPDATE tasks SET args='{}', output=NULL, mcp_result=NULL, payload_purged=1, payload_purged_at=?
       WHERE status IN ${doneSql} AND payload_purged=0 AND changed<?`
    ).run(now, cutoff);
    return Number(res.changes);
  }

  maintain(taskDays = 7, auditDays = 90, dcrClientDays = 30, usageDays = 210, resultTtlMinutes = 30) {
    this.tx(() => {
      this.flushLiveSeen();
      const now = Date.now();
      this.flushLiveOAuthActivity(now);
      this._downgradeExpiredProUsers(now);
      for (const t of this.db.prepare(`SELECT id,status FROM tasks WHERE status NOT IN ${doneSql} AND deadline<?`).all(now)) {
        this.finish(String(t.id), t.status === 'queued' ? 'timed_out' : 'interrupted',
          t.status === 'queued' ? 'Expired before dispatch.' : 'Agent result was not received. Check the device before retrying.');
      }
      this.purgeExpiredPayloads(resultTtlMinutes, now);
      this.db.prepare(`DELETE FROM tasks WHERE status IN ${doneSql} AND changed<?`).run(now - taskDays * day);
      this.db.prepare('DELETE FROM usage_events WHERE created_at<?').run(now - Math.max(usageDays, 210) * day);
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
        const devCheck = this.db.prepare('SELECT boot,revoked,caps,approval_mode FROM devices WHERE id=?').get(device) as { boot: string | null; revoked: number; caps?: string; approval_mode?: string | null } | undefined;
        if (devCheck && !devCheck.revoked && devCheck.boot === boot) {
          const hasWork = this.db.prepare(`SELECT 1 FROM tasks WHERE device=? AND status IN ${outstandingSql} LIMIT 1`).get(device);
          if (!hasWork) {
            mem.seen = now;
            mem.dirty = true;
            const fastCaps = parseDeviceCaps(devCheck.caps);
            return {
              jobs: [],
              cancel: [],
              ack: [],
              approvalMode: normalizeApprovalMode(devCheck.approval_mode),
              ...(fastCaps ? { capabilities: fastCaps } : {})
            };
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
          this.db.prepare('UPDATE usage_events SET status=? WHERE task_id=?').run(u.status, u.id);
        }
      }
      const approvalMode = normalizeApprovalMode(dev.approval_mode);
      const ownerRow = dev.user_id
        ? (this.db.prepare('SELECT email FROM users WHERE id=?').get(dev.user_id) as { email?: string | null } | undefined)
        : undefined;
      const parsedCaps = parseDeviceCaps(dev.caps);
      const deviceMeta = {
        ...(dev.name ? { deviceName: String(dev.name).slice(0, 128) } : {}),
        ...(ownerRow?.email ? { userEmail: String(ownerRow.email).slice(0, 256) } : {}),
        ...(parsedCaps ? { capabilities: parsedCaps } : {})
      };
      const active = this.db.prepare(`SELECT * FROM tasks WHERE device=? AND status IN ${liveSql} ORDER BY created`).all(device) as TaskRow[];
      if (!ready) return { jobs: [], cancel: active.filter(task => task.cancel).map(task => task.id), ack, approvalMode, ...deviceMeta };
      const pending = this.db.prepare("SELECT * FROM tasks WHERE device=? AND status='queued' AND deadline>? ORDER BY created LIMIT ?")
        .all(device, now, Math.max(0, maxActive - active.length)) as TaskRow[];
      for (const t of pending) {
        this.db.prepare("UPDATE tasks SET status='dispatched',boot=?,changed=?,deadline=? WHERE id=?").run(boot, now, now + dispatchMs, t.id);
        this.db.prepare("UPDATE usage_events SET status='dispatched' WHERE task_id=?").run(t.id);
        this.audit('task_dispatched', { id: t.id, device }, t.user_id);
      }
      const jobs = [...active.filter(t => t.status === 'dispatched'), ...pending].map(t => ({ id: t.id, op: t.op, args: JSON.parse(t.args) }));
      return { jobs, cancel: active.filter(t => t.cancel).map(t => t.id), ack, approvalMode, ...deviceMeta };
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

  // --- Admin Governance ---

  private _revokeUserSessions(userId: string): number {
    const res = this.db.prepare(
      "DELETE FROM auth WHERE kind IN ('dashboard','access','code','refresh') AND json_extract(data,'$.userId')=?"
    ).run(userId);
    const prefix = `${userId}\0`;
    for (const key of this.liveOAuthActivity.keys()) {
      if (key.startsWith(prefix)) this.liveOAuthActivity.delete(key);
    }
    return Number(res.changes);
  }

  adminOverview(now = Date.now()) {
    this.downgradeExpiredProUsers(now);
    const d = new Date(now);
    const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const since30d = now - 30 * day;
    const month = utcMonthKey(now);

    const userStats = this.db.prepare(
      `SELECT
        COUNT(*) AS total_users,
        SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active_users,
        SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END) AS disabled_users,
        SUM(CASE WHEN plan='pro' THEN 1 ELSE 0 END) AS pro_users,
        SUM(CASE WHEN plan='free' THEN 1 ELSE 0 END) AS free_users,
        SUM(CASE WHEN role='admin' THEN 1 ELSE 0 END) AS admin_users
      FROM users`
    ).get() as Record<string, number | null>;

    const allDevices = this.devices();
    const activeDevices = allDevices.filter(dev => !dev.revoked);
    const onlineDevices = activeDevices.filter(dev => dev.online).length;

    const monthCalls = this.monthlyCalls(undefined, now);
    const monthBillableRow = this.db.prepare('SELECT COALESCE(SUM(billable_calls),0) AS n FROM usage_monthly WHERE month=?')
      .get(month) as { n: number };
    const last30dRow = this.db.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE created_at>=?')
      .get(since30d) as { n: number };
    const activeTasksRow = this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ${doneSql}`)
      .get() as { n: number };
    const activeInvitesRow = this.db.prepare(
      'SELECT COUNT(*) AS n FROM registration_invites WHERE revoked=0 AND used_count<max_uses AND (expires_at IS NULL OR expires_at>?)'
    ).get(now) as { n: number };
    const activeCodesRow = this.db.prepare(
      'SELECT COUNT(*) AS n FROM redeem_codes WHERE revoked=0 AND used_count<max_uses AND (expires_at IS NULL OR expires_at>?)'
    ).get(now) as { n: number };
    const totalRedemptionsRow = this.db.prepare('SELECT COUNT(*) AS n FROM redeem_redemptions')
      .get() as { n: number };

    return {
      users: {
        total: Number(userStats.total_users ?? 0),
        active: Number(userStats.active_users ?? 0),
        disabled: Number(userStats.disabled_users ?? 0),
        pro: Number(userStats.pro_users ?? 0),
        free: Number(userStats.free_users ?? 0),
        admin: Number(userStats.admin_users ?? 0)
      },
      devices: {
        total: activeDevices.length,
        online: onlineDevices,
        offline: activeDevices.length - onlineDevices,
        revoked: allDevices.length - activeDevices.length
      },
      usage: {
        month,
        monthStart: new Date(monthStart).toISOString(),
        monthCalls,
        monthBillableCalls: Number(monthBillableRow.n ?? 0),
        last30dCalls: Number(last30dRow.n ?? 0),
        activeTasks: Number(activeTasksRow.n ?? 0)
      },
      codes: {
        activeInvites: Number(activeInvitesRow.n ?? 0),
        activeRedeemCodes: Number(activeCodesRow.n ?? 0),
        totalRedemptions: Number(totalRedemptionsRow.n ?? 0)
      },
      generatedAt: new Date(now).toISOString()
    };
  }

  adminListUsers(options?: { search?: string; role?: string; status?: string; plan?: string; limit?: number; now?: number }) {
    const now = options?.now ?? Date.now();
    this.downgradeExpiredProUsers(now);
    const month = utcMonthKey(now);
    const defaultQuota = this.getDefaultFreeMonthlyQuota();

    const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as Record<string, unknown>[];
    const billableRows = this.db.prepare('SELECT user_id, billable_calls FROM usage_monthly WHERE month=?')
      .all(month) as { user_id: string; billable_calls: number }[];
    const billableMap = new Map(billableRows.map(r => [String(r.user_id), Number(r.billable_calls)]));

    const deviceCounts = new Map<string, { total: number; online: number }>();
    for (const dev of this.devices()) {
      if (dev.revoked || !dev.userId) continue;
      const cur = deviceCounts.get(dev.userId) ?? { total: 0, online: 0 };
      cur.total++;
      if (dev.online) cur.online++;
      deviceCounts.set(dev.userId, cur);
    }

    const search = (options?.search ?? '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, options?.limit ?? 100));

    const items = rows.map(row => {
      const user = mapUser(row);
      const devStat = deviceCounts.get(user.id) ?? { total: 0, online: 0 };
      const billableCalls = billableMap.get(user.id) ?? 0;
      return {
        ...user,
        planExpiresAt: user.planExpiresAt ? new Date(user.planExpiresAt).toISOString() : null,
        effectiveQuota: user.plan === 'pro' ? null : (user.customMonthlyQuota ?? defaultQuota),
        billableMonthlyCalls: billableCalls,
        deviceCount: devStat.total,
        onlineDeviceCount: devStat.online,
        createdAt: new Date(Number(row.created_at)).toISOString(),
        lastLoginAt: row.last_login_at ? new Date(Number(row.last_login_at)).toISOString() : null
      };
    }).filter(u => {
      if (options?.role && u.role !== options.role) return false;
      if (options?.status && u.status !== options.status) return false;
      if (options?.plan && u.plan !== options.plan) return false;
      if (search) {
        const hay = `${u.email ?? ''} ${u.displayName ?? ''} ${u.id}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    return items.slice(0, limit);
  }

  adminSetUserStatus(targetUserId: string, status: 'active' | 'disabled', actorUserId: string) {
    return this.tx(() => {
      if (targetUserId === actorUserId && status === 'disabled') {
        throw new Error('Cannot disable your own admin account.');
      }
      const target = this.findUserById(targetUserId);
      if (!target) return null;
      this.db.prepare('UPDATE users SET status=? WHERE id=?').run(status, targetUserId);
      const revokedSessions = status === 'disabled' ? this._revokeUserSessions(targetUserId) : 0;
      this.audit('admin_user_status_updated', {
        targetUserId,
        email: target.email,
        status,
        revokedSessions
      }, actorUserId);
      return {
        user: this.findUserById(targetUserId)!,
        revokedSessions
      };
    });
  }

  adminForceLogoutUser(targetUserId: string, actorUserId: string): { revokedSessions: number } | null {
    return this.tx(() => {
      const target = this.findUserById(targetUserId);
      if (!target) return null;
      const revokedSessions = this._revokeUserSessions(targetUserId);
      this.audit('admin_user_force_logout', {
        targetUserId,
        email: target.email,
        revokedSessions
      }, actorUserId);
      return { revokedSessions };
    });
  }

  adminUpdateUserPlan(
    targetUserId: string,
    input: { plan: 'free' | 'pro'; durationDays?: number | null; customMonthlyQuota?: number | null; now?: number },
    actorUserId: string
  ): PlanQuotaStatus | null {
    return this.tx(() => {
      const now = input.now ?? Date.now();
      this._downgradeExpiredProUsers(now, targetUserId);
      const target = this.findUserById(targetUserId);
      if (!target) return null;

      let newExpiresAt: number | null = null;
      if (input.plan === 'pro' && input.durationDays !== null && input.durationDays !== undefined) {
        const base = target.plan === 'pro' && target.planExpiresAt ? Math.max(now, target.planExpiresAt) : now;
        newExpiresAt = base + input.durationDays * day;
      }

      this.db.prepare('UPDATE users SET plan=?, plan_expires_at=? WHERE id=?').run(input.plan, newExpiresAt, targetUserId);
      if (input.customMonthlyQuota !== undefined) {
        this.db.prepare('UPDATE users SET custom_monthly_quota=? WHERE id=?').run(input.customMonthlyQuota, targetUserId);
      }

      this.audit('admin_user_plan_updated', {
        targetUserId,
        email: target.email,
        previousPlan: target.plan,
        newPlan: input.plan,
        durationDays: input.durationDays ?? null,
        newExpiresAt: newExpiresAt ? new Date(newExpiresAt).toISOString() : null,
        ...(input.customMonthlyQuota !== undefined ? { customMonthlyQuota: input.customMonthlyQuota } : {})
      }, actorUserId);

      return this._buildUserPlanStatus(targetUserId, now)!;
    });
  }

  adminListRegistrationInvites(limit = 100, now = Date.now()) {
    const rows = this.db.prepare(
      `SELECT r.*, u.email AS created_by_email
       FROM registration_invites r
       LEFT JOIN users u ON u.id = r.created_by
       ORDER BY r.created_at DESC
       LIMIT ?`
    ).all(limit) as Record<string, unknown>[];
    return rows.map(r => {
      const expiresAt = r.expires_at !== null && r.expires_at !== undefined ? Number(r.expires_at) : null;
      const revoked = Boolean(r.revoked);
      const usedCount = Number(r.used_count ?? 0);
      const maxUses = Number(r.max_uses ?? 1);
      const active = !revoked && usedCount < maxUses && (expiresAt === null || expiresAt > now);
      return {
        codeHash: String(r.code_hash),
        prefix: String(r.code_prefix),
        note: r.note ? String(r.note) : null,
        maxUses,
        usedCount,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        revoked,
        active,
        createdByEmail: r.created_by_email ? String(r.created_by_email) : null,
        createdAt: new Date(Number(r.created_at)).toISOString()
      };
    });
  }

  revokeRegistrationInvite(codeHash: string, actorUserId?: string): boolean {
    return this.tx(() => {
      const row = this.db.prepare('SELECT code_prefix FROM registration_invites WHERE code_hash=? AND revoked=0')
        .get(codeHash) as { code_prefix: string } | undefined;
      if (!row) return false;
      this.db.prepare('UPDATE registration_invites SET revoked=1 WHERE code_hash=?').run(codeHash);
      this.audit('registration_invite_revoked', { prefix: row.code_prefix }, actorUserId);
      return true;
    });
  }

  adminListRedeemCodes(limit = 100, now = Date.now()) {
    const rows = this.db.prepare(
      `SELECT c.*, u.email AS created_by_email
       FROM redeem_codes c
       LEFT JOIN users u ON u.id = c.created_by
       ORDER BY c.created_at DESC
       LIMIT ?`
    ).all(limit) as Record<string, unknown>[];
    return rows.map(r => {
      const expiresAt = r.expires_at !== null && r.expires_at !== undefined ? Number(r.expires_at) : null;
      const revoked = Boolean(r.revoked);
      const usedCount = Number(r.used_count ?? 0);
      const maxUses = Number(r.max_uses ?? 1);
      const active = !revoked && usedCount < maxUses && (expiresAt === null || expiresAt > now);
      return {
        codeHash: String(r.code_hash),
        prefix: String(r.code_prefix),
        tier: (redeemTiers.some(t => t === r.tier) ? r.tier : 'monthly') as RedeemTier,
        durationDays: r.duration_days !== null && r.duration_days !== undefined ? Number(r.duration_days) : null,
        note: r.note ? String(r.note) : null,
        maxUses,
        usedCount,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        revoked,
        active,
        createdByEmail: r.created_by_email ? String(r.created_by_email) : null,
        createdAt: new Date(Number(r.created_at)).toISOString()
      };
    });
  }

  adminListRedemptions(limit = 50) {
    const rows = this.db.prepare(
      `SELECT r.*, u.email AS user_email
       FROM redeem_redemptions r
       LEFT JOIN users u ON u.id = r.user_id
       ORDER BY r.redeemed_at DESC, r.id DESC
       LIMIT ?`
    ).all(limit) as Record<string, unknown>[];
    return rows.map(r => ({
      id: Number(r.id),
      codePrefix: String(r.code_prefix),
      userId: String(r.user_id),
      userEmail: r.user_email ? String(r.user_email) : null,
      tier: (redeemTiers.some(t => t === r.tier) ? r.tier : 'monthly') as RedeemTier,
      durationDays: r.duration_days !== null && r.duration_days !== undefined ? Number(r.duration_days) : null,
      previousPlan: r.previous_plan === 'pro' ? 'pro' : 'free',
      newPlan: r.new_plan === 'pro' ? 'pro' : 'free',
      newExpiresAt: r.new_expires_at !== null && r.new_expires_at !== undefined ? new Date(Number(r.new_expires_at)).toISOString() : null,
      redeemedAt: new Date(Number(r.redeemed_at)).toISOString()
    }));
  }

  adminListDevices(options?: { search?: string; status?: string; limit?: number }) {
    const userRows = this.db.prepare('SELECT id, email, display_name FROM users').all() as {
      id: string; email: string | null; display_name: string | null;
    }[];
    const userMap = new Map(userRows.map(u => [String(u.id), u]));
    const search = (options?.search ?? '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, options?.limit ?? 200));

    return this.devices()
      .map(dev => {
        const owner = dev.userId ? userMap.get(dev.userId) : undefined;
        return {
          ...dev,
          ownerEmail: owner?.email ? String(owner.email) : null,
          ownerDisplayName: owner?.display_name ? String(owner.display_name) : null
        };
      })
      .filter(dev => {
        if (options?.status === 'online' && !dev.online) return false;
        if (options?.status === 'offline' && (dev.online || dev.revoked)) return false;
        if (options?.status === 'revoked' && !dev.revoked) return false;
        if (search) {
          const hay = `${dev.name} ${dev.id} ${dev.ownerEmail ?? ''} ${dev.ownerDisplayName ?? ''}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      })
      .slice(0, limit);
  }

  adminRevokeDevice(deviceId: string, actorUserId: string): boolean {
    return this.tx(() => {
      const row = this.db.prepare('SELECT id, user_id, name FROM devices WHERE id=? AND revoked=0')
        .get(deviceId) as { id: string; user_id: string | null; name: string } | undefined;
      if (!row) return false;
      this.db.prepare('UPDATE devices SET revoked=1, seen=0 WHERE id=?').run(deviceId);
      this.liveSeen.delete(deviceId);
      this.interruptRevokedDeviceTasks(deviceId);
      this.audit('admin_device_revoked', {
        device: deviceId,
        name: row.name,
        ownerUserId: row.user_id
      }, actorUserId);
      return true;
    });
  }

  adminRecentAudit(options?: { limit?: number; event?: string; search?: string }) {
    const limit = Math.max(1, Math.min(200, options?.limit ?? 100));
    const eventFilter = (options?.event ?? '').trim();
    const search = (options?.search ?? '').trim().toLowerCase();
    const scanLimit = eventFilter || search ? 500 : limit;
    const rows = this.db.prepare(
      `SELECT a.id, a.user_id, a.at, a.event, a.details, u.email AS user_email
       FROM audit a
       LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.id DESC
       LIMIT ?`
    ).all(scanLimit) as Record<string, unknown>[];

    return rows
      .map(row => ({
        id: Number(row.id),
        userId: row.user_id ? String(row.user_id) : null,
        userEmail: row.user_email ? String(row.user_email) : null,
        at: new Date(Number(row.at)).toISOString(),
        event: String(row.event),
        details: JSON.parse(String(row.details))
      }))
      .filter(row => {
        if (eventFilter && row.event !== eventFilter) return false;
        if (search) {
          const hay = `${row.event} ${row.userEmail ?? ''} ${row.userId ?? ''} ${JSON.stringify(row.details)}`.toLowerCase();
          if (!hay.includes(search)) return false;
        }
        return true;
      })
      .slice(0, limit);
  }
}
