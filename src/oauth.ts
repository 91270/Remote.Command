import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { body, json, bearer } from './http.js';
import { hash, match, secret } from './protocol.js';
import type { Store } from './store.js';

const scope = 'remote:use';
const accessMs = 3600000;
const refreshMs = 30 * 86400000;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const opaque = /^[A-Za-z0-9_-]{43}$/;
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;
type Grant = { redirect: string; challenge: string };
export type OAuthConfig = { origin: string; clientId: string; clientSecret: string; ownerKey: string; redirects: Set<string> };

export class OAuth {
  readonly resource: string;
  constructor(private readonly store: Store, private readonly cfg: OAuthConfig) {
    this.resource = cfg.origin + '/mcp';
    if (!opaque.test(cfg.ownerKey) || !opaque.test(cfg.clientSecret) || match(cfg.ownerKey, cfg.clientSecret) ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(cfg.clientId) || !cfg.redirects.size) throw new Error('Invalid OAuth configuration. Check the client ID, redirect URIs and distinct 43-character credentials.');
    for (const raw of cfg.redirects) {
      const url = new URL(raw);
      if (url.hash || url.username || url.password ||
          (url.protocol !== 'https:' && !(cfg.origin.startsWith('http://127.0.0.1:') && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
        throw new Error('Invalid OAuth redirect URI.');
      }
    }
  }
  challenge(res: ServerResponse) {
    json(res, 401, { error: 'unauthorized' }, {
      'WWW-Authenticate': `Bearer resource_metadata="${this.cfg.origin}/.well-known/oauth-protected-resource/mcp", scope="${scope}"`
    });
  }
  authenticated(req: IncomingMessage) {
    const token = bearer(req);
    return !!token && !!this.store.db.prepare("SELECT 1 FROM auth WHERE digest=? AND kind='access' AND expires>?")
      .get(hash(token), Date.now());
  }
  sign(data: string) {
    return createHmac('sha256', this.cfg.ownerKey).update(data).digest('base64url');
  }
  save(kind: string, ttl: number, data: object) {
    const token = secret();
    this.store.db.prepare('INSERT INTO auth VALUES(?,?,?,?)').run(hash(token), kind, Date.now() + ttl, JSON.stringify(data));
    return token;
  }
  find(token: string, kind: string) {
    return this.store.db.prepare('SELECT data FROM auth WHERE digest=? AND kind=? AND expires>?').get(hash(token), kind, Date.now());
  }
  tokens() {
    return { access_token: this.save('access', accessMs, {}), token_type: 'Bearer', expires_in: accessMs / 1000,
      refresh_token: this.save('refresh', refreshMs, {}), scope };
  }
  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url;
    if (req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(pathname)) {
      json(res, 200, { resource: this.resource, authorization_servers: [this.cfg.origin], scopes_supported: [scope], bearer_methods_supported: ['header'] },
        { 'Access-Control-Allow-Origin': '*' });
      return true;
    }
    if (req.method === 'GET' && pathname === '/.well-known/oauth-authorization-server') {
      json(res, 200, { issuer: this.cfg.origin, authorization_response_iss_parameter_supported: true,
        authorization_endpoint: this.cfg.origin + '/oauth/authorize', token_endpoint: this.cfg.origin + '/oauth/token',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: [scope] }, { 'Access-Control-Allow-Origin': '*' });
      return true;
    }
    if (pathname === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) {
      const params = req.method === 'GET' ? url.searchParams : new URLSearchParams(await body(req, 'application/x-www-form-urlencoded', 16000));
      this.authorize(params, res, req.method === 'POST');
      return true;
    }
    if (pathname === '/oauth/token' && req.method === 'POST') {
      this.exchange(req, res, new URLSearchParams(await body(req, 'application/x-www-form-urlencoded', 16000)));
      return true;
    }
    return false;
  }
  authorize(p: URLSearchParams, res: ServerResponse, post: boolean) {
    const fields = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'resource', 'scope'];
    const invalid = () => json(res, 400, { error: 'invalid_request' });
    if ([...new Set(p.keys())].some(k => p.getAll(k).length > 1)) return invalid();
    if (p.get('client_id') !== this.cfg.clientId || !this.cfg.redirects.has(p.get('redirect_uri') ?? '') ||
        p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' ||
        !opaque.test(p.get('code_challenge') ?? '') || (p.get('state')?.length ?? 0) < 1 ||
        (p.get('state')?.length ?? 0) > 1024 || p.get('resource') !== this.resource ||
        (p.has('scope') && p.get('scope') !== scope)) return invalid();
    const fieldsData = fields.filter(k => p.has(k)).map(k => [k, p.get(k)!] as const);
    if (!post) {
      const until = String(Date.now() + 300000);
      const proof = this.sign(JSON.stringify([fieldsData, until]));
      const inputs = [...fieldsData, ['until', until], ['proof', proof]].map(([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k!)}" value="${escapeHtml(v!)}">`).join('');
      const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Remote.Command authorization</title>
<h1>Authorize Remote.Command</h1><p>Allow this ChatGPT connection to request tools on your paired devices. Changes and commands still require confirmation on the device.</p>
<form method="post" action="/oauth/authorize">${inputs}<label>Owner key <input name="owner_key" type="password" required autocomplete="off"></label>
<button>Authorize</button></form>`;
      // A browser form POST from a no-referrer page would send Origin: null.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin',
        'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" }).end(html);
      return;
    }
    const until = p.get('until') ?? '', proof = p.get('proof') ?? '', ownerKey = p.get('owner_key') ?? '';
    if (!/^\d{13}$/.test(until) || Number(until) <= Date.now() || !match(proof, this.sign(JSON.stringify([fieldsData, until]))) ||
        !match(ownerKey, this.cfg.ownerKey)) return json(res, 403, { error: 'access_denied' });
    const redirect = new URL(p.get('redirect_uri')!);
    const code = this.store.tx(() => {
      const code = this.save('code', 120000, { redirect: p.get('redirect_uri'), challenge: p.get('code_challenge') });
      this.store.audit('oauth_authorized');
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
        const [headerId, headerKey] = Buffer.from(basic[1]!, 'base64').toString().split(':');
        if (!id || id === headerId) { id = headerId ?? null; key = headerKey ?? null; }
      } else { id = key = null; }
    }
    if (id !== this.cfg.clientId || !match(key ?? '', this.cfg.clientSecret))
      return json(res, 401, { error: 'invalid_client' }, { 'WWW-Authenticate': 'Basic realm="remote-mcp"' });
    const resource = p.get('resource');
    if (resource !== this.resource && !(resource === null && p.get('grant_type') === 'refresh_token'))
      return json(res, 400, { error: 'invalid_target' });
    const grant = p.get('grant_type');
    if (grant !== 'authorization_code' && grant !== 'refresh_token') return json(res, 400, { error: 'unsupported_grant_type' });
    const token = p.get(grant === 'authorization_code' ? 'code' : 'refresh_token') ?? '';
    const result = this.store.tx(() => {
      const saved = opaque.test(token) && this.find(token, grant === 'authorization_code' ? 'code' : 'refresh');
      if (!saved) return;
      if (grant === 'authorization_code') {
        const data = JSON.parse(String(saved.data)) as Grant;
        const verifier = p.get('code_verifier') ?? '';
        if (p.get('redirect_uri') !== data.redirect || !verifierPattern.test(verifier) || !match(hash(verifier), data.challenge)) return;
      } else if (p.has('scope') && p.get('scope') !== scope) return;
      this.store.db.prepare('DELETE FROM auth WHERE digest=?').run(hash(token));
      this.store.audit(grant === 'authorization_code' ? 'oauth_token_issued' : 'oauth_token_refreshed');
      return this.tokens();
    });
    return result ? json(res, 200, result, { Pragma: 'no-cache' }) : json(res, 400, { error: 'invalid_grant' });
  }
}
