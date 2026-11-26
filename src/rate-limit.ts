import type { IncomingMessage } from 'node:http';
import { hash } from './protocol.js';

export type RateLimitRule = {
  max: number;
  windowMs: number;
};

export type RateLimitStatus = {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
};

export type RateLimitBucket =
  | 'login_failure'
  | 'oauth_register'
  | 'google_activate'
  | 'device_start'
  | 'device_pair';

export type RateLimitConfig = {
  trustProxy?: boolean;
  maxKeys?: number;
  now?: () => number;
  rules?: Partial<Record<RateLimitBucket, RateLimitRule>>;
};

const defaultRules: Record<RateLimitBucket, RateLimitRule> = {
  login_failure: { max: 10, windowMs: 15 * 60_000 },
  oauth_register: { max: 20, windowMs: 60 * 60_000 },
  google_activate: { max: 10, windowMs: 15 * 60_000 },
  device_start: { max: 20, windowMs: 15 * 60_000 },
  device_pair: { max: 20, windowMs: 15 * 60_000 }
};

function normalizeIp(raw: string | undefined): string {
  if (!raw) return 'unknown';
  const trimmed = raw.trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.slice(7);
  return trimmed || 'unknown';
}

function isPrivateOrLoopback(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) return true;
  return false;
}

export function clientIp(req: IncomingMessage, trustProxy = false): string {
  const remote = normalizeIp(req.socket?.remoteAddress);
  if (!trustProxy || !isPrivateOrLoopback(remote)) return remote;

  const xff = req.headers['x-forwarded-for'];
  const headerValue = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  if (typeof headerValue === 'string' && headerValue.trim()) {
    const hops = headerValue.split(',').map(part => normalizeIp(part)).filter(p => p && p !== 'unknown');
    // Walk right-to-left skipping trusted private proxy hops to avoid spoofed left-most headers.
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isPrivateOrLoopback(hops[i]!)) return hops[i]!;
    }
    if (hops.length > 0) return hops[0]!;
  }

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return normalizeIp(realIp);
  return remote;
}

export function ipDigest(ip: string): string {
  return hash(ip).slice(0, 12);
}

type WindowEntry = { timestamps: number[]; lastTouched: number };

export class RateLimiter {
  readonly trustProxy: boolean;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly rules: Record<RateLimitBucket, RateLimitRule>;
  private readonly entries = new Map<string, WindowEntry>();
  private readonly auditMarks = new Map<string, number>();

  constructor(config: RateLimitConfig = {}) {
    this.trustProxy = !!config.trustProxy;
    this.maxKeys = Math.max(100, config.maxKeys ?? 10_000);
    this.now = config.now ?? (() => Date.now());
    this.rules = {
      ...defaultRules,
      ...config.rules
    };
  }

  clientIp(req: IncomingMessage): string {
    return clientIp(req, this.trustProxy);
  }

  private rule(bucket: RateLimitBucket): RateLimitRule {
    return this.rules[bucket];
  }

  private compositeKey(bucket: RateLimitBucket, key: string): string {
    return `${bucket}:${key}`;
  }

  private pruneEntry(entry: WindowEntry, cutoff: number) {
    let idx = 0;
    while (idx < entry.timestamps.length && entry.timestamps[idx]! <= cutoff) idx++;
    if (idx > 0) entry.timestamps.splice(0, idx);
  }

  private enforceCapacity(now: number) {
    if (this.entries.size < this.maxKeys) return;
    for (const [k, entry] of this.entries) {
      const bucket = k.slice(0, k.indexOf(':')) as RateLimitBucket;
      const rule = this.rules[bucket];
      if (!rule || now - entry.lastTouched >= rule.windowMs) {
        this.entries.delete(k);
      }
    }
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  check(bucket: RateLimitBucket, key: string): RateLimitStatus {
    const now = this.now();
    const { max, windowMs } = this.rule(bucket);
    const ck = this.compositeKey(bucket, key);
    const entry = this.entries.get(ck);
    if (!entry) return { allowed: true, remaining: max, retryAfterSec: 0 };

    this.pruneEntry(entry, now - windowMs);
    if (entry.timestamps.length === 0) {
      this.entries.delete(ck);
      return { allowed: true, remaining: max, retryAfterSec: 0 };
    }
    if (entry.timestamps.length >= max) {
      const oldest = entry.timestamps[0]!;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      return { allowed: false, remaining: 0, retryAfterSec };
    }
    return { allowed: true, remaining: max - entry.timestamps.length, retryAfterSec: 0 };
  }

  consume(bucket: RateLimitBucket, key: string): RateLimitStatus {
    const now = this.now();
    const { max, windowMs } = this.rule(bucket);
    const ck = this.compositeKey(bucket, key);
    let entry = this.entries.get(ck);
    if (entry) {
      this.pruneEntry(entry, now - windowMs);
      this.entries.delete(ck);
    } else {
      this.enforceCapacity(now);
      entry = { timestamps: [], lastTouched: now };
    }

    if (entry.timestamps.length >= max) {
      entry.lastTouched = now;
      this.entries.set(ck, entry);
      const oldest = entry.timestamps[0]!;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      return { allowed: false, remaining: 0, retryAfterSec };
    }

    entry.timestamps.push(now);
    entry.lastTouched = now;
    this.entries.set(ck, entry);
    return { allowed: true, remaining: max - entry.timestamps.length, retryAfterSec: 0 };
  }

  reset(bucket: RateLimitBucket, key: string): void {
    this.entries.delete(this.compositeKey(bucket, key));
  }

  shouldAudit(bucket: RateLimitBucket, key: string, cooldownMs = 60_000): boolean {
    const now = this.now();
    const ck = this.compositeKey(bucket, key);
    const last = this.auditMarks.get(ck);
    if (last !== undefined && now - last < cooldownMs) return false;
    if (this.auditMarks.size >= this.maxKeys) {
      for (const [k, at] of this.auditMarks) {
        if (now - at >= cooldownMs) this.auditMarks.delete(k);
      }
      while (this.auditMarks.size >= this.maxKeys) {
        const oldest = this.auditMarks.keys().next().value;
        if (oldest === undefined) break;
        this.auditMarks.delete(oldest);
      }
    }
    this.auditMarks.set(ck, now);
    return true;
  }

  size(): number {
    return this.entries.size;
  }
}
