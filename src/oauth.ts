import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { body, json, bearer, readJson, HttpError } from './http.js';
import { hash, match, secret } from './protocol.js';
import { ipDigest, type RateLimiter } from './rate-limit.js';
import type { Store, UserRecord } from './store.js';

const scope = 'remote:use';
const accessMs = 3600000;
const refreshMs = 30 * 86400000;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const opaque = /^[A-Za-z0-9_-]{43}$/;
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const clientIdPattern = /^[A-Za-z0-9_-]{8,128}$/;
const defaultRedirectHosts = ['chatgpt.com', 'platform.openai.com'];
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

type Grant = { clientId?: string; redirect: string; challenge: string; userId?: string };
type ResolvedClient = {
  clientId: string;
  clientName: string | null;
  redirects: Set<string>;
  authMethod: string;
  verifySecret: (candidate: string) => boolean;
};

export type OAuthConfig = {
  origin: string;
  clientId?: string;
  clientSecret?: string;
  ownerKey: string;
  redirects?: Set<string>;
  allowedRedirectHosts?: Set<string>;
  googleEnabled?: boolean;
  rateLimiter?: RateLimiter;
};

export class OAuth {
  readonly resource: string;
  private readonly allowedRedirectHosts: Set<string>;
  private readonly sessionCookieName: string;

  constructor(private readonly store: Store, private readonly cfg: OAuthConfig) {
    this.resource = cfg.origin + '/mcp';
    this.sessionCookieName = cfg.origin.startsWith('https:') ? '__Host-rcm_dashboard' : 'rcm_dashboard';
    if (!opaque.test(cfg.ownerKey)) {
      throw new Error('Invalid OAuth configuration. Owner key must be a 43-character credential.');
    }
    this.allowedRedirectHosts = new Set(
      cfg.allowedRedirectHosts && cfg.allowedRedirectHosts.size > 0
        ? cfg.allowedRedirectHosts
        : defaultRedirectHosts
    );
    if (cfg.clientId) {
      if (!cfg.clientSecret || !opaque.test(cfg.clientSecret) || match(cfg.ownerKey, cfg.clientSecret) ||
          !clientIdPattern.test(cfg.clientId) || !cfg.redirects?.size) {
        throw new Error('Invalid OAuth configuration. Check the client ID, redirect URIs and distinct 43-character credentials.');
      }
      for (const raw of cfg.redirects) {
        if (!this.isValidRedirectUri(raw, true)) {
          throw new Error('Invalid OAuth redirect URI.');
        }
        try {
          this.allowedRedirectHosts.add(new URL(raw).hostname);
        } catch {
          throw new Error('Invalid OAuth redirect URI.');
        }
      }
    }
  }

  private sessionUser(req: IncomingMessage): UserRecord | null {
    const entries = (req.headers.cookie ?? '').split(';').map(value => value.trim().split('='));
    const matching = entries.filter(([name]) => name === this.sessionCookieName);
    if (matching.length !== 1) return null;
    const token = matching[0]?.[1];
    if (!token || !opaque.test(token)) return null;
    const record = this.store.getAuth(token, 'dashboard');
    if (!record || typeof record.data.userId !== 'string') return null;
    const user = this.store.findUserById(record.data.userId);
    if (!user || user.status !== 'active') return null;
    return user;
  }

  private isValidRedirectUri(raw: string, skipHostCheck = false): boolean {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (url.hash || url.username || url.password) return false;
    const isLoopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if (url.protocol !== 'https:' && !isLoopback) return false;
    if (skipHostCheck || isLoopback || this.allowedRedirectHosts.has('*')) return true;
    return this.allowedRedirectHosts.has(url.hostname);
  }

  private resolveClient(clientId: string): ResolvedClient | null {
    if (!clientId) return null;
    if (this.cfg.clientId && clientId === this.cfg.clientId && this.cfg.clientSecret && this.cfg.redirects) {
      const expected = this.cfg.clientSecret;
      return {
        clientId: this.cfg.clientId,
        clientName: 'Configured MCP Client',
        redirects: this.cfg.redirects,
        authMethod: 'client_secret_post',
        verifySecret: (candidate: string) => match(candidate, expected)
      };
    }
    const dynamic = this.store.findOAuthClient(clientId);
    if (!dynamic) return null;
    const expectedHash = Buffer.from(dynamic.clientSecretHash);
    return {
      clientId: dynamic.clientId,
      clientName: dynamic.clientName,
      redirects: new Set(dynamic.redirectUris),
      authMethod: dynamic.tokenEndpointAuthMethod,
      verifySecret: (candidate: string) => {
        if (!candidate) return false;
        const actualHash = Buffer.from(hash(candidate));
        return actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);
      }
    };
  }

  challenge(res: ServerResponse) {
    json(res, 401, { error: 'unauthorized' }, {
      'WWW-Authenticate': `Bearer resource_metadata="${this.cfg.origin}/.well-known/oauth-protected-resource/mcp", scope="${scope}"`
    });
  }

  authenticateAccess(req: IncomingMessage): { token: string; userId?: string } | null {
    const token = bearer(req);
    if (!token) return null;
    const record = this.store.getAuth(token, 'access');
    if (!record) return null;
    const userId = typeof record.data.userId === 'string' ? record.data.userId : undefined;
    if (userId) {
      const user = this.store.findUserById(userId);
      if (!user || user.status !== 'active') return null;
    }
    const clientId = typeof record.data.clientId === 'string' && record.data.clientId ? record.data.clientId : undefined;
    if (clientId) {
      this.store.recordOAuthActivity(userId, clientId, record.digest);
    }
    return { token, userId };
  }

  authenticated(req: IncomingMessage) {
    return !!this.authenticateAccess(req);
  }

  sign(data: string) {
    return createHmac('sha256', this.cfg.ownerKey).update(data).digest('base64url');
  }

  save(kind: string, ttl: number, data: Record<string, unknown>) {
    const token = secret();
    this.store.putAuth(token, kind, ttl, data);
    return token;
  }

  find(token: string, kind: string) {
    return this.store.getAuth(token, kind);
  }

  tokens(context: Record<string, unknown> = {}) {
    const sessionId = typeof context.sessionId === 'string' && context.sessionId ? context.sessionId : randomUUID();
    const payload = { ...context, sessionId };
    return {
      access_token: this.save('access', accessMs, payload),
      token_type: 'Bearer',
      expires_in: accessMs / 1000,
      refresh_token: this.save('refresh', refreshMs, payload),
      scope
    };
  }

  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url;
    if (req.method === 'OPTIONS' && (pathname.startsWith('/.well-known/oauth-') || pathname === '/oauth/register')) {
      res.writeHead(204, corsHeaders).end();
      return true;
    }
    if (req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(pathname)) {
      json(res, 200, {
        resource: this.resource,
        authorization_servers: [this.cfg.origin],
        scopes_supported: [scope],
        bearer_methods_supported: ['header']
      }, { 'Access-Control-Allow-Origin': '*' });
      return true;
    }
    if (req.method === 'GET' && ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'].includes(pathname)) {
      json(res, 200, {
        issuer: this.cfg.origin,
        authorization_response_iss_parameter_supported: true,
        authorization_endpoint: this.cfg.origin + '/oauth/authorize',
        token_endpoint: this.cfg.origin + '/oauth/token',
        registration_endpoint: this.cfg.origin + '/oauth/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
        scopes_supported: [scope]
      }, { 'Access-Control-Allow-Origin': '*' });
      return true;
    }
    if (pathname === '/oauth/register' && req.method === 'POST') {
      await this.register(req, res);
      return true;
    }
    if (pathname === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) {
      const params = req.method === 'GET' ? url.searchParams : new URLSearchParams(await body(req, 'application/x-www-form-urlencoded', 16000));
      this.authorize(req, params, res, req.method === 'POST', url);
      return true;
    }
    if (pathname === '/oauth/token' && req.method === 'POST') {
      this.exchange(req, res, new URLSearchParams(await body(req, 'application/x-www-form-urlencoded', 16000)));
      return true;
    }
    return false;
  }

  private async register(req: IncomingMessage, res: ServerResponse) {
    if (this.cfg.rateLimiter) {
      const limiter = this.cfg.rateLimiter;
      const ip = limiter.clientIp(req);
      const status = limiter.consume('oauth_register', ip);
      if (!status.allowed) {
        if (limiter.shouldAudit('oauth_register', ip)) {
          this.store.audit('rate_limited', { bucket: 'oauth_register', route: '/oauth/register', ip: ipDigest(ip) });
        }
        return json(
          res,
          429,
          { error: 'too_many_requests', error_description: 'Too many client registration requests.' },
          { ...corsHeaders, 'Retry-After': String(status.retryAfterSec) }
        );
      }
    }
    let raw: unknown;
    try {
      raw = await readJson(req, 16384);
    } catch (error) {
      if (error instanceof HttpError) return json(res, error.status, { error: 'invalid_client_metadata', error_description: error.message }, corsHeaders);
      return json(res, 400, { error: 'invalid_client_metadata' }, corsHeaders);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return json(res, 400, { error: 'invalid_client_metadata' }, corsHeaders);
    }
    const input = raw as Record<string, unknown>;
    const redirectUris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
    if (redirectUris.length === 0 || redirectUris.length > 16 || !redirectUris.every(u => typeof u === 'string' && this.isValidRedirectUri(u))) {
      return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'One or more redirect_uris are invalid or not permitted.' }, corsHeaders);
    }
    const clientName = typeof input.client_name === 'string' && input.client_name.trim()
      ? input.client_name.trim().slice(0, 120)
      : null;
    const grantTypes = Array.isArray(input.grant_types) && input.grant_types.every(g => typeof g === 'string')
      ? input.grant_types as string[]
      : ['authorization_code', 'refresh_token'];
    if (!grantTypes.includes('authorization_code')) {
      return json(res, 400, { error: 'invalid_client_metadata', error_description: 'authorization_code grant_type is required.' }, corsHeaders);
    }
    const responseTypes = Array.isArray(input.response_types) && input.response_types.every(r => typeof r === 'string')
      ? input.response_types as string[]
      : ['code'];
    if (!responseTypes.includes('code')) {
      return json(res, 400, { error: 'invalid_client_metadata', error_description: 'code response_type is required.' }, corsHeaders);
    }
    const authMethod = typeof input.token_endpoint_auth_method === 'string'
      ? input.token_endpoint_auth_method
      : 'client_secret_post';
    if (!['client_secret_basic', 'client_secret_post', 'none'].includes(authMethod)) {
      return json(res, 400, { error: 'invalid_client_metadata', error_description: 'Unsupported token_endpoint_auth_method.' }, corsHeaders);
    }
    const registered = this.store.registerOAuthClient({
      clientName,
      redirectUris: redirectUris as string[],
      grantTypes,
      responseTypes,
      tokenEndpointAuthMethod: authMethod,
      scope: typeof input.scope === 'string' ? input.scope : scope
    });
    json(res, 201, {
      client_id: registered.clientId,
      client_secret: registered.clientSecret,
      client_id_issued_at: Math.floor(registered.createdAt / 1000),
      client_secret_expires_at: 0,
      ...(clientName ? { client_name: clientName } : {}),
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: authMethod,
      scope
    }, corsHeaders);
  }

  authorize(req: IncomingMessage, p: URLSearchParams, res: ServerResponse, post: boolean, url?: URL) {
    const fields = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'resource', 'scope'];
    const invalid = () => json(res, 400, { error: 'invalid_request' });
    if ([...new Set(p.keys())].some(k => p.getAll(k).length > 1)) return invalid();
    const client = this.resolveClient(p.get('client_id') ?? '');
    const redirectUri = p.get('redirect_uri') ?? '';
    if (!client || !client.redirects.has(redirectUri) ||
        p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' ||
        !opaque.test(p.get('code_challenge') ?? '') || (p.get('state')?.length ?? 0) < 1 ||
        (p.get('state')?.length ?? 0) > 1024 || p.get('resource') !== this.resource ||
        (p.has('scope') && p.get('scope') !== scope)) return invalid();
    const fieldsData = fields.filter(k => p.has(k)).map(k => [k, p.get(k)!] as const);
    const activeUser = this.sessionUser(req);

    if (!post) {
      const until = String(Date.now() + 300000);
      const proof = this.sign(JSON.stringify([fieldsData, until]));
      const inputs = [...fieldsData, ['until', until], ['proof', proof]].map(([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k!)}" value="${escapeHtml(v!)}">`).join('');
      const clientLabel = escapeHtml(client.clientName || client.clientId);
      const rawRedirectOrigin = new URL(redirectUri).origin;
      const redirectOrigin = escapeHtml(rawRedirectOrigin);
      const returnPath = '/oauth/authorize' + (url?.search ?? ('?' + p.toString()));
      const googleHref = '/auth/google/start?return_to=' + encodeURIComponent(returnPath);

      let cardBody: string;
      if (activeUser) {
        const accountLabel = escapeHtml(activeUser.email || activeUser.username || activeUser.id);
        cardBody = `<form class="login-card" method="post" action="/oauth/authorize">
        ${inputs}
        <input type="hidden" name="session_auth" value="1">
        <h2>授权连接</h2>
        <p>客户端 <strong>${clientLabel}</strong> 请求以账号 <strong>${accountLabel}</strong> 访问你的已配对设备，授权后将回调至 <code>${redirectOrigin}</code>。</p>
        <button type="submit" class="primary">确认授权</button>
      </form>`;
      } else {
        const googleBlock = this.cfg.googleEnabled
          ? `<a href="${escapeHtml(googleHref)}" class="primary button-link">使用 Google 账号继续</a>`
          : '';
        const passwordBlock = !this.cfg.googleEnabled || this.store.hasPasswordAdmin()
          ? `<form method="post" action="/oauth/authorize">
        ${inputs}
        <label for="auth-username">管理员账号</label>
        <input id="auth-username" name="username" type="text" value="admin" required autocomplete="username">
        <label for="auth-password">密码</label>
        <input id="auth-password" name="password" type="password" required autocomplete="current-password">
        <button type="submit" class="${this.cfg.googleEnabled ? 'secondary' : 'primary'}">确认授权</button>
      </form>`
          : '';
        cardBody = `<div class="login-card">
        <h2>授权连接</h2>
        <p>客户端 <strong>${clientLabel}</strong> 请求访问权限，授权后将回调至 <code>${redirectOrigin}</code>。</p>
        ${googleBlock}
        ${passwordBlock}
      </div>`;
      }

      const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Remote.Command · 授权连接</title>
  <link rel="stylesheet" href="/manage/assets/dashboard.css">
</head>
<body>
  <section class="login-view">
    <div class="login-intro">
      <div class="brand"><span class="brand-mark" aria-hidden="true">RC</span><span>Remote.Command</span></div>
      <h1>授权外部<br>MCP 客户端</h1>
      <p>允许客户端通过自建 Gateway 请求已配对设备工具。所有写入、配置修改与命令执行仍需在设备端本地确认。</p>
      <div class="connection-map" aria-label="外部客户端连接自建 Gateway，Gateway 连接设备">
        <span>${clientLabel}</span><i aria-hidden="true"></i><span>Gateway</span><i aria-hidden="true"></i><span>设备</span>
      </div>
    </div>
    <div class="login-main">
      ${cardBody}
    </div>
  </section>
</body>
</html>`;
      // A browser form POST from a no-referrer page would send Origin: null.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'strict-origin',
        'Content-Security-Policy': `default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self' ${rawRedirectOrigin}; frame-ancestors 'none'; base-uri 'none'`
      }).end(html);
      return;
    }

    const until = p.get('until') ?? '', proof = p.get('proof') ?? '';
    if (!/^\d{13}$/.test(until) || Number(until) <= Date.now() || !match(proof, this.sign(JSON.stringify([fieldsData, until])))) {
      return json(res, 403, { error: 'access_denied' });
    }

    let authorizedUser: UserRecord | null = null;
    if (p.get('session_auth') === '1') {
      authorizedUser = activeUser;
      if (!authorizedUser || authorizedUser.status !== 'active') {
        return json(res, 403, { error: 'access_denied' });
      }
    } else {
      const username = (p.get('username') ?? '').trim(), password = p.get('password') ?? '';
      const limiter = this.cfg.rateLimiter;
      const ip = limiter ? limiter.clientIp(req) : '';
      const userKey = limiter ? `${ip}:${username.toLowerCase()}` : '';
      if (limiter) {
        const ipStatus = limiter.check('login_failure', ip);
        const userStatus = limiter.check('login_failure', userKey);
        if (!ipStatus.allowed || !userStatus.allowed) {
          const retryAfterSec = Math.max(ipStatus.retryAfterSec, userStatus.retryAfterSec);
          if (limiter.shouldAudit('login_failure', ip)) {
            this.store.audit('rate_limited', { bucket: 'login_failure', route: '/oauth/authorize', ip: ipDigest(ip) });
          }
          return json(res, 429, { error: 'too_many_requests' }, { 'Retry-After': String(retryAfterSec) });
        }
      }
      authorizedUser = this.store.authenticateUser(username, password);
      if (!authorizedUser || authorizedUser.status !== 'active') {
        if (limiter) {
          limiter.consume('login_failure', ip);
          limiter.consume('login_failure', userKey);
        }
        return json(res, 403, { error: 'access_denied' });
      }
      if (limiter) {
        limiter.reset('login_failure', ip);
        limiter.reset('login_failure', userKey);
      }
    }

    const redirect = new URL(redirectUri);
    const code = this.store.tx(() => {
      const code = this.save('code', 120000, {
        clientId: client.clientId,
        redirect: redirectUri,
        challenge: p.get('code_challenge'),
        userId: authorizedUser!.id
      });
      this.store.touchOAuthClient(client.clientId);
      this.store.audit('oauth_authorized', {
        clientId: client.clientId,
        username: authorizedUser!.email ?? authorizedUser!.username
      }, authorizedUser!.id);
      return code;
    });
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', p.get('state')!);
    redirect.searchParams.set('iss', this.cfg.origin);
    res.writeHead(303, { Location: redirect.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end();
  }

  exchange(req: IncomingMessage, res: ServerResponse, p: URLSearchParams) {
    if ([...new Set(p.keys())].some(k => p.getAll(k).length > 1)) return json(res, 400, { error: 'invalid_request' });
    let id = p.get('client_id'), key = p.get('client_secret');
    if (req.headers.authorization) {
      const basic = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(req.headers.authorization);
      if (basic && !key) {
        const raw = Buffer.from(basic[1]!, 'base64').toString();
        const colon = raw.indexOf(':');
        const headerId = colon >= 0 ? raw.slice(0, colon) : raw;
        const headerKey = colon >= 0 ? raw.slice(colon + 1) : '';
        if (!id || id === headerId) { id = headerId; key = headerKey; }
      } else { id = key = null; }
    }
    const client = id ? this.resolveClient(id) : null;
    const secretOk = client ? (client.authMethod === 'none' && !key ? true : client.verifySecret(key ?? '')) : false;
    if (!client || !secretOk) {
      return json(res, 401, { error: 'invalid_client' }, { 'WWW-Authenticate': 'Basic realm="remote-mcp"' });
    }
    const resource = p.get('resource');
    if (resource !== this.resource && !(resource === null && p.get('grant_type') === 'refresh_token'))
      return json(res, 400, { error: 'invalid_target' });
    const grant = p.get('grant_type');
    if (grant !== 'authorization_code' && grant !== 'refresh_token') return json(res, 400, { error: 'unsupported_grant_type' });
    const token = p.get(grant === 'authorization_code' ? 'code' : 'refresh_token') ?? '';
    const result = this.store.tx(() => {
      const now = Date.now();
      const saved = opaque.test(token) ? this.find(token, grant === 'authorization_code' ? 'code' : 'refresh') : undefined;
      if (!saved) return;
      const savedData = saved.data;
      let userId: string | undefined = typeof savedData.userId === 'string' ? savedData.userId : undefined;
      let redirectOrigin: string | undefined;
      if (grant === 'authorization_code') {
        const data = savedData as unknown as Grant;
        const verifier = p.get('code_verifier') ?? '';
        if ((data.clientId && data.clientId !== client.clientId) ||
            p.get('redirect_uri') !== data.redirect ||
            !verifierPattern.test(verifier) ||
            !match(hash(verifier), data.challenge)) return;
        userId = data.userId;
        try { redirectOrigin = new URL(data.redirect).origin; } catch { /* ignore invalid redirect */ }
      } else {
        if (typeof savedData.clientId === 'string' && savedData.clientId !== client.clientId) return;
        if (p.has('scope') && p.get('scope') !== scope) return;
        redirectOrigin = typeof savedData.redirectOrigin === 'string' ? savedData.redirectOrigin : undefined;
      }

      if (userId) {
        const user = this.store.findUserById(userId);
        if (!user || user.status !== 'active') return;
      }

      this.store.deleteAuthByDigest(saved.digest);
      this.store.touchOAuthClient(client.clientId, now);
      this.store.audit(grant === 'authorization_code' ? 'oauth_token_issued' : 'oauth_token_refreshed', { clientId: client.clientId }, userId);
      const sessionId = grant === 'refresh_token' && typeof savedData.sessionId === 'string' ? savedData.sessionId : undefined;
      const candidateDevice = grant === 'refresh_token' && typeof savedData.selectedDevice === 'string' ? savedData.selectedDevice : undefined;
      const selectedDevice = candidateDevice && this.store.devices(userId).some(d => d.id === candidateDevice && !d.revoked)
        ? candidateDevice
        : undefined;
      const authorizedAt = grant === 'refresh_token' && typeof savedData.authorizedAt === 'number'
        ? savedData.authorizedAt
        : now;
      const clientName = client.clientName ?? (typeof savedData.clientName === 'string' ? savedData.clientName : undefined);
      const tokenContext: Record<string, unknown> = {
        clientId: client.clientId,
        authorizedAt,
        lastActiveAt: now,
        ...(clientName ? { clientName } : {}),
        ...(redirectOrigin ? { redirectOrigin } : {}),
        ...(userId ? { userId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(selectedDevice ? { selectedDevice } : {})
      };
      const issued = this.tokens(tokenContext);
      this.store.recordOAuthActivity(userId, client.clientId, undefined, now);
      return issued;
    });
    return result ? json(res, 200, result, { Pragma: 'no-cache' }) : json(res, 400, { error: 'invalid_grant' });
  }
}
