import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { HttpError, json, readJson } from './http.js';
import { capabilities, hash, match, secret, terminal, uuid, type Capability } from './protocol.js';
import type { Store } from './store.js';

const sessionLifetime = 8 * 60 * 60 * 1000;
const key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const deviceName = z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const pairingCode = z.string().trim().regex(/^[A-Za-z0-9-]{4,32}$/);
const assets = new Map([
  ['/manage/assets/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/manage/assets/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']]
]);

type DashboardConfig = { origin: string };
type Session = { digest: string; csrf: string; username?: string };
type DeviceVerification = {
  preview(code: string): { deviceName: string; expiresAt: string } | undefined;
  verify(code: string, name: string | undefined, caps: Capability[], approve: boolean): { status: string; deviceName: string };
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
    const digest = hash(token);
    const row = this.store.db.prepare("SELECT data FROM auth WHERE digest=? AND kind='dashboard' AND expires>?").get(digest, Date.now());
    if (!row) return;
    const stored = z.object({ csrf: key, username: z.string().optional() }).safeParse(JSON.parse(String(row.data)));
    if (stored.success) return { digest, csrf: stored.data.csrf, username: stored.data.username };
  }

  private async page(res: ServerResponse, filename: string, contentType: string) {
    const content = await readFile(new URL('../web/' + filename, import.meta.url));
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    }).end(content);
  }

  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
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
      if (req.method === 'POST' && url.pathname === '/manage/api/login') {
        const input = z.strictObject({
          username: z.string().trim().min(1).max(80),
          password: z.string().min(1).max(256)
        }).parse(await readJson(req, 4096));
        const user = this.store.authenticateUser(input.username, input.password);
        if (!user || user.role !== 'admin') throw new HttpError(403, 'Username or password is incorrect.');
        const token = secret(), csrf = secret();
        this.store.tx(() => {
          const previous = this.session(req);
          if (previous) this.store.db.prepare('DELETE FROM auth WHERE digest=?').run(previous.digest);
          this.store.db.prepare('INSERT INTO auth VALUES(?,?,?,?)').run(
            hash(token), 'dashboard', Date.now() + sessionLifetime,
            JSON.stringify({ csrf, userId: user.id, username: user.username, role: user.role })
          );
          this.store.audit('dashboard_login', { username: user.username });
        });
        json(res, 200, { csrf, username: user.username }, { 'Set-Cookie': this.cookie(token, sessionLifetime / 1000) });
        return true;
      }
      const session = this.session(req);
      if (!session) throw new HttpError(401, 'Sign in to manage this Gateway.');
      if (req.method === 'POST' && (!key.safeParse(req.headers['x-csrf-token']).success || !match(String(req.headers['x-csrf-token']), session.csrf)))
        throw new HttpError(403, 'CSRF token is missing or invalid.');
      if (req.method === 'GET' && url.pathname === '/manage/api/session') {
        json(res, 200, { csrf: session.csrf, username: session.username ?? 'admin', origin: this.config.origin, mcpUrl: this.config.origin + '/mcp' });
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/manage/api/overview') {
        const devices = this.store.devices();
        const counts = this.store.db.prepare('SELECT status,count(*) AS count FROM tasks GROUP BY status').all();
        const taskCounts = Object.fromEntries(counts.map(row => [String(row.status), Number(row.count)]));
        json(res, 200, { devices, taskCounts, totalCalls: this.store.totalCalls(),
          activeTasks: Object.entries(taskCounts).filter(([status]) => !terminal.some(value => value === status)).reduce((sum, [, count]) => sum + count, 0),
          mcpUrl: this.config.origin + '/mcp', serverTime: new Date().toISOString() });
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/manage/api/tasks') {
        const selected = url.searchParams.get('device');
        if (selected) uuid.parse(selected);
        const query = selected ? 'SELECT id FROM tasks WHERE device=? ORDER BY created DESC LIMIT 60' : 'SELECT id FROM tasks ORDER BY created DESC LIMIT 60';
        const rows = selected ? this.store.db.prepare(query).all(selected) : this.store.db.prepare(query).all();
        const tasks = rows.map(row => this.store.task(String(row.id))).filter(task => task !== undefined)
          .map(task => ({ ...this.store.view(task), output: undefined, result: undefined }));
        json(res, 200, { tasks });
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/manage/api/audit') {
        const records = this.store.db.prepare('SELECT id,at,event,details FROM audit ORDER BY id DESC LIMIT 80').all()
          .map(row => ({ id: row.id, at: new Date(Number(row.at)).toISOString(), event: row.event, details: JSON.parse(String(row.details)) }));
        json(res, 200, { records });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/manage/api/invites') {
        const input = z.strictObject({ name: deviceName, capabilities: z.array(z.enum(capabilities)).min(1).max(3) }).parse(await readJson(req, 4096));
        if (new Set(input.capabilities).size !== input.capabilities.length) throw new HttpError(400, 'Duplicate capability.');
        const token = this.store.invite(input.name, input.capabilities);
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
        const input = z.strictObject({ user_code: pairingCode, name: deviceName.optional(),
          capabilities: z.array(z.enum(capabilities)).min(1).max(3), approve: z.boolean() }).parse(await readJson(req, 4096));
        if (new Set(input.capabilities).size !== input.capabilities.length) throw new HttpError(400, 'Duplicate capability.');
        let result;
        try { result = this.deviceFlow.verify(input.user_code, input.name, input.capabilities, input.approve); }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Device pairing failed.'); }
        json(res, 200, result);
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/manage/api/devices/revoke-all') {
        z.strictObject({}).parse(await readJson(req, 4096));
        json(res, 200, this.store.revokeAllDevices());
        return true;
      }
      const deviceAction = /^\/manage\/api\/devices\/([^/]+)\/(rename|revoke)$/.exec(url.pathname);
      if (req.method === 'POST' && deviceAction) {
        const id = uuid.parse(deviceAction[1]);
        if (deviceAction[2] === 'revoke') {
          z.strictObject({}).parse(await readJson(req, 4096));
          if (!this.store.revoke(id)) throw new HttpError(404, 'Device is unknown or already revoked.');
        } else {
          const input = z.strictObject({ name: deviceName }).parse(await readJson(req, 4096));
          this.store.tx(() => {
            if (!this.store.db.prepare('UPDATE devices SET name=? WHERE id=? AND revoked=0').run(input.name, id).changes) throw new HttpError(404, 'Device is unknown or revoked.');
            this.store.audit('device_renamed', { device: id, name: input.name });
          });
        }
        json(res, 200, { ok: true });
        return true;
      }
      const taskAction = /^\/manage\/api\/tasks\/([^/]+)(\/cancel)?$/.exec(url.pathname);
      if (taskAction && (req.method === 'GET' && !taskAction[2] || req.method === 'POST' && taskAction[2])) {
        const id = uuid.parse(taskAction[1]);
        const task = this.store.task(id);
        if (!task) throw new HttpError(404, 'Task is unknown or expired.');
        if (req.method === 'POST') {
          z.strictObject({}).parse(await readJson(req, 4096));
          json(res, 200, this.store.cancel(id));
        } else json(res, 200, this.store.view(task));
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/manage/api/oauth/revoke') {
        z.strictObject({}).parse(await readJson(req, 4096));
        this.store.tx(() => {
          this.store.db.exec("DELETE FROM auth WHERE kind IN ('access','code','refresh')");
          this.store.audit('oauth_revoked_all');
        });
        json(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/manage/api/logout') {
        z.strictObject({}).parse(await readJson(req, 4096));
        this.store.tx(() => {
          this.store.db.prepare("DELETE FROM auth WHERE digest=? AND kind='dashboard'").run(session.digest);
          this.store.audit('dashboard_logout');
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
