import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { readJson, json, bearer } from './http.js';
import { hash, match, secret, uuid, type Capability } from './protocol.js';
import type { Store } from './store.js';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const verifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/[- ]/g, '');
type Enrollment = {
  code: string; name: string; challenge: string; lastPoll: number; status: 'pending' | 'approved' | 'denied' | 'issued';
  deviceId?: string; credentialDigest?: string;
  caps?: Capability[];
};
export class DeviceFlow {
  constructor(private store: Store, private origin: string) {}
  start(name: string, challenge: string) {
    return this.store.tx(() => {
      const deviceCode = secret();
      let userCode: string;
      do { userCode = randomBytes(5).toString('hex').toUpperCase(); }
      while (this.findUserCode(userCode));
      this.store.db.prepare('INSERT INTO auth VALUES(?,?,?,?)').run(hash(deviceCode), 'device-enrollment', Date.now() + 600000,
        JSON.stringify({ code: userCode, name, challenge, lastPoll: 0, status: 'pending' } satisfies Enrollment));
      return { device_code: deviceCode, user_code: userCode.slice(0, 5) + '-' + userCode.slice(5),
        verification_uri: this.origin + '/manage', verification_uri_complete: this.origin + '/manage?user_code=' + userCode,
        expires_in: 600, interval: 2 };
    });
  }
  findUserCode(code: string) {
    return this.store.db.prepare("SELECT digest,data,expires FROM auth WHERE kind='device-enrollment' AND expires>? AND json_extract(data,'$.code')=?")
      .get(Date.now(), normalizeCode(code));
  }
  preview(code: string) {
    const row = this.findUserCode(code);
    if (!row) return;
    const enrollment = JSON.parse(String(row.data)) as Enrollment;
    if (enrollment.status === 'pending') return { deviceName: enrollment.name, expiresAt: new Date(Number(row.expires)).toISOString() };
  }
  verify(code: string, name: string | undefined, caps: Capability[], approve: boolean) {
    return this.store.tx(() => {
      const row = this.findUserCode(code);
      if (!row) throw new Error('Unknown or expired device code.');
      const enrollment = JSON.parse(String(row.data)) as Enrollment;
      if (enrollment.status !== 'pending') throw new Error('The code already received a decision.');
      enrollment.status = approve ? 'approved' : 'denied';
      enrollment.name = name ?? enrollment.name;
      enrollment.caps = caps;
      this.store.db.prepare('UPDATE auth SET data=? WHERE digest=?').run(JSON.stringify(enrollment), row.digest!);
      this.store.audit(approve ? 'device_pairing_approved' : 'device_pairing_denied', { name: enrollment.name, caps });
      return { status: enrollment.status, deviceName: enrollment.name };
    });
  }
  poll(code: string, proof: string, credential: string) {
    return this.store.tx(() => {
      const row = this.store.db.prepare("SELECT data FROM auth WHERE digest=? AND kind='device-enrollment' AND expires>?").get(hash(code), Date.now());
      if (!row) return { error: 'expired_token' };
      const enrollment = JSON.parse(String(row.data)) as Enrollment;
      if (!match(hash(proof), enrollment.challenge)) return { error: 'invalid_grant' };
      if (Date.now() - enrollment.lastPoll < 1500) return { error: 'slow_down' };
      enrollment.lastPoll = Date.now();
      this.store.db.prepare('UPDATE auth SET data=? WHERE digest=?').run(JSON.stringify(enrollment), hash(code));
      if (enrollment.status === 'pending') return { error: 'authorization_pending' };
      if (enrollment.status === 'denied') {
        this.store.db.prepare('DELETE FROM auth WHERE digest=?').run(hash(code));
        return { error: 'access_denied' };
      }
      if (enrollment.status === 'issued') {
        if (enrollment.credentialDigest !== hash(credential)) return { error: 'invalid_grant' };
        return { device_id: enrollment.deviceId!, name: enrollment.name };
      }
      // Use the existing enrollment transaction logic without nested transactions.
      const id = randomUUID();
      this.store.db.prepare('INSERT INTO devices(id,name,credential,caps) VALUES(?,?,?,?)')
        .run(id, enrollment.name, hash(credential), JSON.stringify(enrollment.caps ?? ['read']));
      enrollment.status = 'issued';
      enrollment.deviceId = id;
      enrollment.credentialDigest = hash(credential);
      this.store.db.prepare('UPDATE auth SET data=? WHERE digest=?').run(JSON.stringify(enrollment), hash(code));
      this.store.audit('device_paired', { device: id });
      return { device_id: id, name: enrollment.name };
    });
  }
  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method !== 'POST') return false;
    if (url.pathname === '/device/start') {
      const args = z.strictObject({ client_id: z.literal('private-remote-agent'), device_name: z.string().min(1).max(80).refine(name => !/[\u0000-\u001f\u007f]/.test(name)),
        code_challenge: opaque, code_challenge_method: z.literal('S256') }).parse(await readJson(req, 8192));
      json(res, 200, this.start(args.device_name, args.code_challenge));
      return true;
    }
    if (url.pathname === '/device/poll') {
      const args = z.strictObject({ client_id: z.literal('private-remote-agent'), device_code: opaque, code_verifier: verifier,
        credential: opaque }).parse(await readJson(req, 8192));
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
