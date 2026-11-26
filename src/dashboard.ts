import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { HttpError, json, readJson } from './http.js';
import { capabilities, match, secret, terminal, uuid, type Capability } from './protocol.js';
import type { RateLimiter } from './rate-limit.js';
import type { Store, UserRecord } from './store.js';

const sessionLifetime = 8 * 60 * 60 * 1000;
const key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const deviceName = z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const pairingCode = z.string().trim().regex(/^[A-Za-z0-9-]{4,32}$/);
const oauthClientId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const assets = new Map([
  ['/manage/assets/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/manage/assets/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/assets/landing.css', ['landing.css', 'text/css; charset=utf-8']],
  ['/assets/landing.js', ['landing.js', 'text/javascript; charset=utf-8']]
]);

type DashboardConfig = { origin: string; googleEnabled?: boolean; rateLimiter?: RateLimiter };
type Session = { digest: string; csrf: string; user: UserRecord };
type DeviceVerification = {
  preview(code: string): { deviceName: string; expiresAt: string } | undefined;
  verify(code: string, name: string | undefined, caps: Capability[], approve: boolean, userId?: string): { status: string; deviceName: string };
};

export class Dashboard {
  private readonly cookieName: string;
  constructor(private readonly store: Store, private readonly config: DashboardConfig, private readonly deviceFlow?: DeviceVerification) {
    this.cookieName = config.origin.startsWith('https:') ? '__Host-rcm_dashboard' : 'rcm_dashboard';
  }

  private cookie(token: string, seconds: number) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.config.origin.startsWith('https:') ? '; Secure' : ''}`;
  }

  private session(req: IncomingMessage): Session | undefined {
    const entries = (req.headers.cookie ?? '').split(';').map(value => value.trim().split('='));
    const matching = entries.filter(([name]) => name === this.cookieName);
    if (matching.length !== 1) return;
    const token = matching[0]?.[1];
    if (!token || !key.safeParse(token).success) return;
    const record = this.store.getAuth(token, 'dashboard');
    if (!record) return;
    const stored = z.object({ csrf: key, userId: z.string().min(1) }).safeParse(record.data);
    if (!stored.success) return;
    const user = this.store.findUserById(stored.data.userId);
    if (!user || user.status !== 'active') return;
    return { digest: record.digest, csrf: stored.data.csrf, user };
  }

  private async page(res: ServerResponse, filename: string, contentType: string) {
    const content = await readFile(new URL('../web/' + filename, import.meta.url));
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    }).end(content);
  }

  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method === 'GET' && url.pathname === '/') {
      await this.page(res, 'landing.html', 'text/html; charset=utf-8');
      return true;
    }
    if (req.method === 'GET' && (url.pathname === '/assets/landing.css' || url.pathname === '/assets/landing.js')) {
      const asset = assets.get(url.pathname)!;
      await this.page(res, asset[0]!, asset[1]!);
      return true;
    }
    if (url.pathname !== '/manage' && !url.pathname.startsWith('/manage/')) return false;
    try {
      if (url.origin !== this.config.origin || req.headers.origin && req.headers.origin !== this.config.origin) throw new HttpError(403, 'Origin not allowed.');
      if (req.method === 'GET' && (url.pathname === '/manage' || url.pathname === '/manage/')) {
        await this.page(res, 'index.html', 'text/html; charset=utf-8');
        return true;
      }
      const asset = assets.get(url.pathname);
      if (req.method === 'GET' && asset) {
        await this.page(res, asset[0]!, asset[1]!);
        return true;
      }
      if (!url.pathname.startsWith('/manage/api/')) throw new HttpError(404, 'Not found.');
      if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      if (req.method === 'POST' && req.headers.origin !== this.config.origin) throw new HttpError(403, 'Origin required.');

      if (req.method === 'GET' && url.pathname === '/manage/api/auth-config') {
        json(res, 200, {
          googleEnabled: true,
          registrationMode: this.store.getRegistrationMode(),
          initialized: this.store.userCount() > 0
        });
        return true;
      }

      const session = this.session(req);
      if (!session) throw new HttpError(401, 'Sign in to manage this Gateway.');
      if (req.method === 'POST' && (!key.safeParse(req.headers['x-csrf-token']).success || !match(String(req.headers['x-csrf-token']), session.csrf)))
        throw new HttpError(403, 'CSRF token is missing or invalid.');

      const userId = session.user.id;

      if (req.method === 'GET' && url.pathname === '/manage/api/session') {
        json(res, 200, {
          csrf: session.csrf,
          userId,
          username: session.user.username ?? session.user.email ?? 'user',
          email: session.user.email,
          displayName: session.user.displayName,
          role: session.user.role,
          plan: session.user.plan,
          googleEnabled: !!this.config.googleEnabled,
          origin: this.config.origin,
          mcpUrl: this.config.origin + '/mcp'
        });
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/manage/api/overview') {
        const devices = this.store.devices(userId);
        const taskCounts = this.store.taskStatusCounts(userId);
        json(res, 200, {
          devices,
          taskCounts,
          totalCalls: this.store.totalCalls(userId),
          activeTasks: Object.entries(taskCounts).filter(([status]) => !terminal.some(value => value === status)).reduce((sum, [, count]) => sum + count, 0),
          mcpUrl: this.config.origin + '/mcp',
          serverTime: new Date().toISOString()
        });
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/manage/api/tasks') {
        const selected = url.searchParams.get('device');
        if (selected) uuid.parse(selected);
        const tasks = this.store.recentTasks(60, selected ?? undefined, userId)
          .map(task => ({ ...task, output: undefined, result: undefined }));
        json(res, 200, { tasks });
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/manage/api/audit') {
        const records = this.store.recentAudit(80, userId);
        json(res, 200, { records });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/manage/api/invites') {
        const input = z.strictObject({ name: deviceName, capabilities: z.array(z.enum(capabilities)).min(1).max(3) }).parse(await readJson(req, 4096));
        if (new Set(input.capabilities).size !== input.capabilities.length) throw new HttpError(400, 'Duplicate capability.');
        const token = this.store.invite(input.name, input.capabilities, userId);
        json(res, 201, { token, expiresAt: new Date(Date.now() + 600000).toISOString(), capabilities: input.capabilities });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/manage/api/device-preview') {
        if (!this.deviceFlow) throw new HttpError(404, 'Device pairing is unavailable.');
        const { user_code } = z.strictObject({ user_code: pairingCode }).parse(await readJson(req, 4096));
        const pairing = this.deviceFlow.preview(user_code);
        if (!pairing) throw new HttpError(404, 'This pairing code has expired, was already used, or could not be found.');
        json(res, 200, pairing);
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/manage/api/device-verify') {
        if (!this.deviceFlow) throw new HttpError(404, 'Device pairing is unavailable.');
        const input = z.strictObject({
          user_code: pairingCode,
          name: deviceName.optional(),
          capabilities: z.array(z.enum(capabilities)).min(1).max(3),
          approve: z.boolean()
        }).parse(await readJson(req, 4096));
        if (new Set(input.capabilities).size !== input.capabilities.length) throw new HttpError(400, 'Duplicate capability.');
        let result;
        try { result = this.deviceFlow.verify(input.user_code, input.name, input.capabilities, input.approve, userId); }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Device pairing failed.'); }
        json(res, 200, result);
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/manage/api/devices/revoke-all') {
        z.strictObject({}).parse(await readJson(req, 4096));
        json(res, 200, this.store.revokeAllDevices(userId));
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/manage/api/devices/clear-revoked') {
        z.strictObject({}).parse(await readJson(req, 4096));
        json(res, 200, { ok: true, ...this.store.clearRevokedDevices(userId) });
        return true;
      }
      const deviceAction = /^\/manage\/api\/devices\/([^/]+)\/(rename|revoke|delete)$/.exec(url.pathname);
      if (req.method === 'POST' && deviceAction) {
        const id = uuid.parse(deviceAction[1]);
        if (deviceAction[2] === 'revoke') {
          z.strictObject({}).parse(await readJson(req, 4096));
          if (!this.store.revoke(id, userId)) throw new HttpError(404, 'Device is unknown or already revoked.');
        } else if (deviceAction[2] === 'delete') {
          z.strictObject({}).parse(await readJson(req, 4096));
          if (!this.store.deleteRevokedDevice(id, userId)) throw new HttpError(404, 'Device is unknown or not revoked.');
        } else {
          const input = z.strictObject({ name: deviceName }).parse(await readJson(req, 4096));
          if (!this.store.renameDevice(id, input.name, userId)) throw new HttpError(404, 'Device is unknown or revoked.');
        }
        json(res, 200, { ok: true });
        return true;
      }
      const taskAction = /^\/manage\/api\/tasks\/([^/]+)(\/cancel)?$/.exec(url.pathname);
      if (taskAction && (req.method === 'GET' && !taskAction[2] || req.method === 'POST' && taskAction[2])) {
        const id = uuid.parse(taskAction[1]);
        const task = this.store.task(id, userId);
        if (!task) throw new HttpError(404, 'Task is unknown or expired.');
        if (req.method === 'POST') {
          z.strictObject({}).parse(await readJson(req, 4096));
          json(res, 200, this.store.cancel(id, userId));
        } else json(res, 200, this.store.view(task));
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/manage/api/oauth/clients') {
        json(res, 200, { clients: this.store.listAuthorizedOAuthClients(userId) });
        return true;
      }
      const oauthClientRevoke = /^\/manage\/api\/oauth\/clients\/([^/]+)\/revoke$/.exec(url.pathname);
      if (req.method === 'POST' && oauthClientRevoke) {
        let rawClientId: string;
        try {
          rawClientId = decodeURIComponent(oauthClientRevoke[1]!);
        } catch {
          throw new HttpError(400, 'Invalid request.');
        }
        const clientId = oauthClientId.parse(rawClientId);
        z.strictObject({}).parse(await readJson(req, 4096));
        const revokedTokens = this.store.revokeOAuthClient(clientId, userId);
        if (!revokedTokens) throw new HttpError(404, 'OAuth client authorization not found or already revoked.');
        json(res, 200, { ok: true, revokedTokens });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/manage/api/oauth/revoke') {
        z.strictObject({}).parse(await readJson(req, 4096));
        this.store.revokeOAuthTokens(userId);
        json(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/manage/api/logout') {
        z.strictObject({}).parse(await readJson(req, 4096));
        this.store.tx(() => {
          this.store.deleteAuthByDigest(session.digest, 'dashboard');
          this.store.audit('dashboard_logout', {}, userId);
        });
        json(res, 200, { ok: true }, { 'Set-Cookie': this.cookie('', 0) });
        return true;
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (error instanceof HttpError) json(res, error.status, { error: error.message });
      else if (error instanceof z.ZodError) json(res, 400, { error: 'Invalid request.' });
      else throw error;
      return true;
    }
  }
}
