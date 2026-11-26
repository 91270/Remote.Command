import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { body, HttpError } from './http.js';
import { hash, match, secret } from './protocol.js';
import { ipDigest, type RateLimiter } from './rate-limit.js';
import type { Store, UserRecord } from './store.js';

const sessionLifetime = 8 * 60 * 60 * 1000;
const oidcFlowLifetime = 10 * 60 * 1000;
const jwksTtlMs = 60 * 60 * 1000;
const defaultDiscoveryUrl = 'https://accounts.google.com/.well-known/openid-configuration';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

type CachedJwks = {
  keys: (JsonWebKey & { kid?: string; kty?: string })[];
  fetchedAt: number;
};

type PendingGoogleProfile = {
  sub: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  returnTo: string;
};

export type GoogleAuthConfig = {
  origin: string;
  clientId: string;
  clientSecret: string;
  adminEmails?: Set<string>;
  discoveryUrl?: string;
  rateLimiter?: RateLimiter;
};

export function sanitizeReturnTo(raw: string | null | undefined): string {
  if (!raw) return '/manage';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) {
    return '/manage';
  }
  if (raw === '/manage' || raw.startsWith('/manage?') || raw.startsWith('/manage/') || raw.startsWith('/oauth/authorize?')) {
    return raw;
  }
  return '/manage';
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const entries = (req.headers.cookie ?? '').split(';').map(v => v.trim().split('='));
  const matching = entries.filter(([k]) => k === name);
  if (matching.length !== 1) return undefined;
  return matching[0]?.[1];
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export class GoogleAuth {
  private readonly sessionCookieName: string;
  private readonly oidcCookieName: string;
  private readonly pendingCookieName: string;
  private readonly adminEmails: Set<string>;
  private readonly discoveryUrl: string;
  private discoveryCache?: { doc: OidcDiscovery; fetchedAt: number };
  private jwksCache?: CachedJwks;

  constructor(private readonly store: Store, private readonly config: GoogleAuthConfig) {
    const secure = config.origin.startsWith('https:');
    this.sessionCookieName = secure ? '__Host-rcm_dashboard' : 'rcm_dashboard';
    this.oidcCookieName = secure ? '__Host-rcm_oidc' : 'rcm_oidc';
    this.pendingCookieName = secure ? '__Host-rcm_google_pending' : 'rcm_google_pending';
    this.adminEmails = new Set([...(config.adminEmails ?? [])].map(e => e.trim().toLowerCase()).filter(Boolean));
    this.discoveryUrl = config.discoveryUrl || defaultDiscoveryUrl;
  }

  get callbackUrl(): string {
    return this.config.origin + '/auth/google/callback';
  }

  private cookieHeader(name: string, value: string, maxAgeSeconds: number, sameSite: 'Lax' | 'Strict' = 'Lax'): string {
    const secure = this.config.origin.startsWith('https:') ? '; Secure' : '';
    return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAgeSeconds}${secure}`;
  }

  private async getDiscovery(): Promise<OidcDiscovery> {
    if (this.discoveryCache && Date.now() - this.discoveryCache.fetchedAt < jwksTtlMs) {
      return this.discoveryCache.doc;
    }
    const res = await fetch(this.discoveryUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new HttpError(502, 'Failed to fetch Google OIDC discovery document.');
    const doc = await res.json() as Partial<OidcDiscovery>;
    if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new HttpError(502, 'Invalid Google OIDC discovery document.');
    }
    const valid: OidcDiscovery = {
      issuer: doc.issuer,
      authorization_endpoint: doc.authorization_endpoint,
      token_endpoint: doc.token_endpoint,
      jwks_uri: doc.jwks_uri
    };
    this.discoveryCache = { doc: valid, fetchedAt: Date.now() };
    return valid;
  }

  private async getJwk(jwksUri: string, kid: string | undefined): Promise<JsonWebKey> {
    const fetchKeys = async () => {
      const res = await fetch(jwksUri, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new HttpError(502, 'Failed to fetch Google JWKS.');
      const data = await res.json() as { keys?: (JsonWebKey & { kid?: string; kty?: string })[] };
      if (!Array.isArray(data.keys)) throw new HttpError(502, 'Invalid Google JWKS.');
      this.jwksCache = { keys: data.keys, fetchedAt: Date.now() };
      return data.keys;
    };

    let keys = (this.jwksCache && Date.now() - this.jwksCache.fetchedAt < jwksTtlMs)
      ? this.jwksCache.keys
      : await fetchKeys();
    let jwk = kid ? keys.find(k => k.kid === kid) : keys[0];
    if (!jwk) {
      keys = await fetchKeys();
      jwk = kid ? keys.find(k => k.kid === kid) : keys[0];
    }
    if (!jwk) throw new HttpError(401, 'Google ID token signing key not found.');
    return jwk;
  }

  private async verifyIdToken(idToken: string, expectedNonce: string, discovery: OidcDiscovery): Promise<{
    sub: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
  }> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new HttpError(401, 'Malformed Google ID token.');
    const [encodedHeader, encodedPayload, encodedSig] = parts as [string, string, string];
    const header = decodeBase64UrlJson(encodedHeader);
    if (header.alg !== 'RS256') throw new HttpError(401, 'Unsupported Google ID token algorithm.');
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    const jwk = await this.getJwk(discovery.jwks_uri, kid);
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    const verified = cryptoVerify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8'),
      publicKey,
      Buffer.from(encodedSig, 'base64url')
    );
    if (!verified) throw new HttpError(401, 'Google ID token signature verification failed.');

    const payload = decodeBase64UrlJson(encodedPayload);
    const nowSec = Math.floor(Date.now() / 1000);
    const validIssuers = new Set([discovery.issuer, 'https://accounts.google.com', 'accounts.google.com']);
    if (typeof payload.iss !== 'string' || !validIssuers.has(payload.iss)) {
      throw new HttpError(401, 'Invalid Google ID token issuer.');
    }
    const audOk = payload.aud === this.config.clientId ||
      (Array.isArray(payload.aud) && payload.aud.includes(this.config.clientId));
    if (!audOk) throw new HttpError(401, 'Invalid Google ID token audience.');
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec - 30) {
      throw new HttpError(401, 'Google ID token has expired.');
    }
    if (typeof payload.iat === 'number' && payload.iat > nowSec + 300) {
      throw new HttpError(401, 'Google ID token issued in the future.');
    }
    if (typeof payload.nonce !== 'string' || !match(payload.nonce, expectedNonce)) {
      throw new HttpError(401, 'Google ID token nonce mismatch.');
    }
    if (payload.email_verified !== true || typeof payload.email !== 'string' || !payload.email.trim()) {
      throw new HttpError(403, 'A verified Google email address is required.');
    }
    if (typeof payload.sub !== 'string' || !payload.sub.trim()) {
      throw new HttpError(401, 'Missing Google subject identifier.');
    }

    return {
      sub: payload.sub.trim(),
      email: payload.email.trim().toLowerCase(),
      displayName: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 120) : null,
      avatarUrl: typeof payload.picture === 'string' && payload.picture.startsWith('https://') ? payload.picture.slice(0, 500) : null
    };
  }

  private issueDashboardSession(res: ServerResponse, user: UserRecord, returnTo: string, clearCookies: string[] = []) {
    const token = secret();
    const csrf = secret();
    this.store.tx(() => {
      this.store.putAuth(token, 'dashboard', sessionLifetime, {
        csrf,
        userId: user.id,
        username: user.username ?? user.email ?? 'user',
        email: user.email,
        role: user.role
      });
      this.store.audit('dashboard_login_google', { email: user.email, role: user.role }, user.id);
    });
    const cookies = [
      this.cookieHeader(this.sessionCookieName, token, sessionLifetime / 1000, 'Lax'),
      ...clearCookies
    ];
    res.writeHead(303, {
      Location: returnTo,
      'Set-Cookie': cookies,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    }).end();
  }

  private renderPage(res: ServerResponse, status: number, title: string, heading: string, bodyHtml: string, headers: Record<string, string | string[]> = {}) {
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Remote.Command · ${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/manage/assets/dashboard.css">
</head>
<body>
  <section class="login-view">
    <div class="login-intro">
      <div class="brand"><span class="brand-mark" aria-hidden="true">RC</span><span>Remote.Command</span></div>
      <h1>${escapeHtml(heading)}</h1>
      <p>通过 Google 账号安全登录自建 Remote MCP Gateway，管理你的个人设备与调用权限。</p>
    </div>
    <div class="login-main">
      ${bodyHtml}
    </div>
  </section>
</body>
</html>`;
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'strict-origin',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...headers
    }).end(html);
  }

  private renderActivateForm(res: ServerResponse, email: string, errorMessage?: string, extraHeaders: Record<string, string | string[]> = {}) {
    const errHtml = errorMessage ? `<p class="error" role="alert">${escapeHtml(errorMessage)}</p>` : '';
    const card = `<form class="login-card" method="post" action="/auth/google/activate">
      <h2>输入注册邀请码</h2>
      <p>Google 账号 <strong>${escapeHtml(email)}</strong> 尚未注册。当前站点开启了邀请码注册，请输入邀请码完成激活。</p>
      <label for="invite-code">注册邀请码</label>
      <input id="invite-code" name="invite_code" type="text" required autocomplete="off" placeholder="粘贴邀请码">
      <button type="submit" class="primary">激活账号</button>
      ${errHtml}
      <p><a href="/manage" class="text-button">返回登录页</a></p>
    </form>`;
    this.renderPage(res, errorMessage ? 400 : 200, '邀请码激活', '激活你的账号', card, extraHeaders);
  }

  private renderError(res: ServerResponse, status: number, message: string, clearCookies: string[] = []) {
    const card = `<div class="login-card">
      <h2>无法完成登录</h2>
      <p class="error" role="alert">${escapeHtml(message)}</p>
      <p><a href="/manage" class="primary button-link">返回登录页</a></p>
    </div>`;
    this.renderPage(res, status, '登录提示', '登录受限', card, clearCookies.length ? { 'Set-Cookie': clearCookies } : {});
  }

  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/auth/google/')) return false;

    if (req.method === 'GET' && url.pathname === '/auth/google/start') {
      const discovery = await this.getDiscovery();
      const state = secret();
      const nonce = secret();
      const verifier = secret() + secret();
      const challenge = hash(verifier);
      const returnTo = sanitizeReturnTo(url.searchParams.get('return_to'));

      this.store.tx(() => {
        this.store.putAuth(state, 'google-oidc', oidcFlowLifetime, {
          nonce,
          verifier,
          returnTo
        });
      });

      const authUrl = new URL(discovery.authorization_endpoint);
      authUrl.searchParams.set('client_id', this.config.clientId);
      authUrl.searchParams.set('redirect_uri', this.callbackUrl);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('nonce', nonce);
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('prompt', 'select_account');

      res.writeHead(302, {
        Location: authUrl.href,
        'Set-Cookie': this.cookieHeader(this.oidcCookieName, state, oidcFlowLifetime / 1000, 'Lax'),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer'
      }).end();
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/auth/google/callback') {
      const clearOidc = this.cookieHeader(this.oidcCookieName, '', 0, 'Lax');
      const errorParam = url.searchParams.get('error');
      if (errorParam) {
        this.renderError(res, 400, `Google 授权已取消或失败 (${errorParam})。`, [clearOidc]);
        return true;
      }
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const cookieState = readCookie(req, this.oidcCookieName) ?? '';
      if (!code || !state || !cookieState || !match(state, cookieState)) {
        this.renderError(res, 400, '登录状态校验失败或已过期，请重新点击 Google 登录。', [clearOidc]);
        return true;
      }

      const saved = this.store.tx(() => {
        const record = this.store.getAuth(state, 'google-oidc');
        if (record) this.store.deleteAuthByDigest(record.digest, 'google-oidc');
        return record;
      });
      if (!saved) {
        this.renderError(res, 400, '登录会话已过期，请重试。', [clearOidc]);
        return true;
      }

      const nonce = String(saved.data.nonce ?? '');
      const verifier = String(saved.data.verifier ?? '');
      const returnTo = sanitizeReturnTo(typeof saved.data.returnTo === 'string' ? saved.data.returnTo : '/manage');
      const discovery = await this.getDiscovery();

      const tokenRes = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          redirect_uri: this.callbackUrl,
          code_verifier: verifier
        })
      });
      if (!tokenRes.ok) {
        this.renderError(res, 502, '无法从 Google 换取登录令牌，请稍后重试。', [clearOidc]);
        return true;
      }
      const tokenJson = await tokenRes.json() as { id_token?: string };
      if (!tokenJson.id_token) {
        this.renderError(res, 502, 'Google 未返回有效的身份令牌（id_token）。', [clearOidc]);
        return true;
      }

      const profile = await this.verifyIdToken(tokenJson.id_token, nonce, discovery);
      const outcome = this.store.createGoogleUser({
        sub: profile.sub,
        email: profile.email,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        adminEmails: this.adminEmails
      });

      if (outcome.status === 'ok') {
        this.issueDashboardSession(res, outcome.user, returnTo, [clearOidc]);
        return true;
      }
      if (outcome.status === 'invite_required') {
        const pendingToken = secret();
        this.store.tx(() => {
          this.store.putAuth(pendingToken, 'google-pending', oidcFlowLifetime, {
            sub: profile.sub,
            email: profile.email,
            displayName: profile.displayName,
            avatarUrl: profile.avatarUrl,
            returnTo
          } satisfies PendingGoogleProfile);
        });
        this.renderActivateForm(res, profile.email, undefined, {
          'Set-Cookie': [
            clearOidc,
            this.cookieHeader(this.pendingCookieName, pendingToken, oidcFlowLifetime / 1000, 'Lax')
          ]
        });
        return true;
      }
      if (outcome.status === 'admin_email_required') {
        this.renderError(res, 403, '系统尚未初始化，仅允许 ADMIN_GOOGLE_EMAILS 指定的管理员邮箱完成首次注册。', [clearOidc]);
        return true;
      }
      if (outcome.status === 'disabled') {
        this.renderError(res, 403, '该账号已被管理员停用。', [clearOidc]);
        return true;
      }
      this.renderError(res, 403, '当前站点暂未开放新用户注册。', [clearOidc]);
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/auth/google/activate') {
      if (this.config.rateLimiter) {
        const limiter = this.config.rateLimiter;
        const ip = limiter.clientIp(req);
        const status = limiter.consume('google_activate', ip);
        if (!status.allowed) {
          if (limiter.shouldAudit('google_activate', ip)) {
            this.store.audit('rate_limited', { bucket: 'google_activate', route: '/auth/google/activate', ip: ipDigest(ip) });
          }
          const card = `<div class="login-card">
      <h2>操作过于频繁</h2>
      <p class="error" role="alert">激活尝试次数过多，请 ${status.retryAfterSec} 秒后再试。</p>
      <p><a href="/manage" class="primary button-link">返回登录页</a></p>
    </div>`;
          this.renderPage(res, 429, '请求过于频繁', '操作过于频繁', card, { 'Retry-After': String(status.retryAfterSec) });
          return true;
        }
      }
      const clearPending = this.cookieHeader(this.pendingCookieName, '', 0, 'Lax');
      const pendingToken = readCookie(req, this.pendingCookieName);
      if (!pendingToken) {
        this.renderError(res, 400, '激活会话已过期，请重新点击 Google 登录。', [clearPending]);
        return true;
      }
      const record = this.store.getAuth(pendingToken, 'google-pending');
      if (!record) {
        this.renderError(res, 400, '激活会话已过期，请重新点击 Google 登录。', [clearPending]);
        return true;
      }
      const pending = record.data as unknown as PendingGoogleProfile;
      const params = new URLSearchParams(await body(req, 'application/x-www-form-urlencoded', 4096));
      const inviteCode = (params.get('invite_code') ?? '').trim();
      if (!inviteCode) {
        this.renderActivateForm(res, pending.email, '请输入有效的注册邀请码。');
        return true;
      }

      const outcome = this.store.createGoogleUser({
        sub: pending.sub,
        email: pending.email,
        displayName: pending.displayName,
        avatarUrl: pending.avatarUrl,
        adminEmails: this.adminEmails,
        inviteCode
      });

      if (outcome.status === 'ok') {
        this.store.tx(() => { this.store.deleteAuthByDigest(record.digest, 'google-pending'); });
        this.issueDashboardSession(res, outcome.user, sanitizeReturnTo(pending.returnTo), [clearPending]);
        return true;
      }
      if (outcome.status === 'invalid_invite') {
        this.renderActivateForm(res, pending.email, '邀请码无效、已用完或已过期，请核对后重试。');
        return true;
      }
      if (outcome.status === 'closed') {
        this.renderError(res, 403, '当前站点已关闭新用户注册。', [clearPending]);
        return true;
      }
      this.renderError(res, 403, '无法完成账号激活，请联系管理员。', [clearPending]);
      return true;
    }

    return false;
  }
}
