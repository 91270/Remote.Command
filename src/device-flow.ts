import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { readJson, json, bearer } from './http.js';
import { agentClientId, hash, match, secret, uuid, type ApprovalMode, type Capability } from './protocol.js';
import { ipDigest, type RateLimiter } from './rate-limit.js';
import type { Store } from './store.js';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const verifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/[- ]/g, '');
type Enrollment = {
  code: string; name: string; challenge: string; lastPoll: number; status: 'pending' | 'approved' | 'denied' | 'issued';
  userId?: string;
  deviceId?: string; credentialDigest?: string;
  caps?: Capability[];
  approvalMode?: ApprovalMode;
};

export class DeviceFlow {
  constructor(private store: Store, private origin: string, private rateLimiter?: RateLimiter) {}

  start(name: string, challenge: string) {
    return this.store.tx(() => {
      const deviceCode = secret();
      let userCode: string;
      do { userCode = randomBytes(5).toString('hex').toUpperCase(); }
      while (this.findUserCode(userCode));
      this.store.putAuth(deviceCode, 'device-enrollment', 600000, {
        code: userCode, name, challenge, lastPoll: 0, status: 'pending'
      } satisfies Enrollment);
      return {
        device_code: deviceCode,
        user_code: userCode.slice(0, 5) + '-' + userCode.slice(5),
        verification_uri: this.origin + '/manage',
        verification_uri_complete: this.origin + '/manage?user_code=' + userCode,
        expires_in: 600,
        interval: 2
      };
    });
  }

  findUserCode(code: string) {
    return this.store.findAuthByJsonField('device-enrollment', '$.code', normalizeCode(code));
  }

  preview(code: string) {
    const row = this.findUserCode(code);
    if (!row) return;
    const enrollment = row.data as unknown as Enrollment;
    if (enrollment.status === 'pending') return { deviceName: enrollment.name, expiresAt: new Date(row.expires).toISOString() };
  }

  verify(code: string, name: string | undefined, caps: Capability[], approve: boolean, userId?: string, approvalMode: ApprovalMode = 'client') {
    return this.store.tx(() => {
      const row = this.findUserCode(code);
      if (!row) throw new Error('Unknown or expired device code.');
      const enrollment = row.data as unknown as Enrollment;
      if (enrollment.status !== 'pending') throw new Error('The code already received a decision.');
      enrollment.status = approve ? 'approved' : 'denied';
      enrollment.name = name ?? enrollment.name;
      enrollment.caps = caps;
      enrollment.approvalMode = approvalMode;
      if (userId) enrollment.userId = userId;
      this.store.updateAuthDataByDigest(row.digest, enrollment as unknown as Record<string, unknown>);
      this.store.audit(approve ? 'device_pairing_approved' : 'device_pairing_denied', { name: enrollment.name, caps, approvalMode }, userId);
      return { status: enrollment.status, deviceName: enrollment.name };
    });
  }

  poll(code: string, proof: string, credential: string) {
    return this.store.tx(() => {
      const row = this.store.getAuth(code, 'device-enrollment');
      if (!row) return { error: 'expired_token' };
      const enrollment = row.data as unknown as Enrollment;
      if (!match(hash(proof), enrollment.challenge)) return { error: 'invalid_grant' };
      if (Date.now() - enrollment.lastPoll < 1500) return { error: 'slow_down' };
      enrollment.lastPoll = Date.now();
      this.store.updateAuthDataByDigest(row.digest, enrollment as unknown as Record<string, unknown>);
      if (enrollment.status === 'pending') return { error: 'authorization_pending' };
      if (enrollment.status === 'denied') {
        this.store.deleteAuthByDigest(row.digest);
        return { error: 'access_denied' };
      }
      if (enrollment.status === 'issued') {
        if (enrollment.credentialDigest !== hash(credential)) return { error: 'invalid_grant' };
        return { device_id: enrollment.deviceId!, name: enrollment.name };
      }
      const created = this.store.createPairedDevice(enrollment.name, credential, enrollment.caps ?? ['read'], enrollment.userId, enrollment.approvalMode ?? 'client');
      enrollment.status = 'issued';
      enrollment.deviceId = created.id;
      enrollment.credentialDigest = hash(credential);
      this.store.updateAuthDataByDigest(row.digest, enrollment as unknown as Record<string, unknown>);
      return { device_id: created.id, name: enrollment.name };
    });
  }

  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method !== 'POST') return false;
    if (url.pathname === '/device/start') {
      if (this.rateLimiter) {
        const ip = this.rateLimiter.clientIp(req);
        const status = this.rateLimiter.consume('device_start', ip);
        if (!status.allowed) {
          if (this.rateLimiter.shouldAudit('device_start', ip)) {
            this.store.audit('rate_limited', { bucket: 'device_start', route: '/device/start', ip: ipDigest(ip) });
          }
          json(res, 429, { error: 'too_many_requests' }, { 'Retry-After': String(status.retryAfterSec) });
          return true;
        }
      }
      const args = z.strictObject({
        client_id: z.literal(agentClientId),
        device_name: z.string().min(1).max(80).refine(name => !/[\u0000-\u001f\u007f]/.test(name)),
        code_challenge: opaque,
        code_challenge_method: z.literal('S256')
      }).parse(await readJson(req, 8192));
      json(res, 200, this.start(args.device_name, args.code_challenge));
      return true;
    }
    if (url.pathname === '/device/poll') {
      const args = z.strictObject({
        client_id: z.literal(agentClientId),
        device_code: opaque,
        code_verifier: verifier,
        credential: opaque
      }).parse(await readJson(req, 8192));
      const result = this.poll(args.device_code, args.code_verifier, args.credential);
      json(res, 'error' in result ? 400 : 200, result);
      return true;
    }
    if (url.pathname === '/device/revoke' || url.pathname === '/device/offline') {
      const token = bearer(req), device = token && this.store.deviceByToken(token);
      if (!device) { json(res, 401, { error: 'unauthorized' }); return true; }
      const payload = await readJson(req, 8192);
      if (url.pathname === '/device/revoke') {
        z.strictObject({}).parse(payload);
        this.store.revoke(device.id);
      } else {
        const { boot } = z.strictObject({ boot: uuid.optional() }).parse(payload);
        this.store.markOffline(device.id, boot ?? device.boot);
      }
      json(res, 200, { success: true });
      return true;
    }
    return false;
  }
}
