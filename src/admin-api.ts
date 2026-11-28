import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { HttpError, json, readJson } from './http.js';
import { uuid } from './protocol.js';
import { redeemTiers, type Store, type UserRecord } from './store.js';

const codeHashParam = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);
const registrationModes = ['invite_only', 'open', 'closed'] as const;

export type AdminApiContext = {
  store: Store;
  actor: UserRecord;
  defaultResultTtlMinutes: number;
};

/** Handles `/manage/api/admin/*` endpoints after the caller has passed session, CSRF, and `admin` role checks. */
export async function handleAdminApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: AdminApiContext
): Promise<boolean> {
  const { store, actor, defaultResultTtlMinutes } = ctx;
  const actorId = actor.id;
  const path = url.pathname;

  if (req.method === 'GET' && path === '/manage/api/admin/overview') {
    json(res, 200, store.adminOverview());
    return true;
  }

  if (req.method === 'GET' && path === '/manage/api/admin/users') {
    const search = url.searchParams.get('q') ?? undefined;
    const role = url.searchParams.get('role') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const plan = url.searchParams.get('plan') || undefined;
    json(res, 200, { users: store.adminListUsers({ search, role, status, plan }) });
    return true;
  }

  const userAction = /^\/manage\/api\/admin\/users\/([^/]+)\/(status|force-logout|plan)$/.exec(path);
  if (req.method === 'POST' && userAction) {
    const targetId = uuid.parse(userAction[1]);
    const action = userAction[2];
    if (action === 'status') {
      const input = z.strictObject({ status: z.enum(['active', 'disabled']) }).parse(await readJson(req, 4096));
      let result;
      try {
        result = store.adminSetUserStatus(targetId, input.status, actorId);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : 'Unable to update user status.');
      }
      if (!result) throw new HttpError(404, 'User not found.');
      json(res, 200, { ok: true, user: result.user, revokedSessions: result.revokedSessions });
      return true;
    }
    if (action === 'force-logout') {
      z.strictObject({}).parse(await readJson(req, 4096));
      const result = store.adminForceLogoutUser(targetId, actorId);
      if (!result) throw new HttpError(404, 'User not found.');
      json(res, 200, { ok: true, revokedSessions: result.revokedSessions });
      return true;
    }
    const input = z.strictObject({
      plan: z.enum(['free', 'pro']),
      durationDays: z.number().int().min(1).max(3650).nullable().optional(),
      customMonthlyQuota: z.number().int().min(1).max(10_000_000).nullable().optional()
    }).parse(await readJson(req, 4096));
    const planQuota = store.adminUpdateUserPlan(targetId, input, actorId);
    if (!planQuota) throw new HttpError(404, 'User not found.');
    json(res, 200, { ok: true, planQuota });
    return true;
  }

  if (req.method === 'GET' && path === '/manage/api/admin/invites') {
    json(res, 200, { invites: store.adminListRegistrationInvites() });
    return true;
  }

  if (req.method === 'POST' && path === '/manage/api/admin/invites') {
    const input = z.strictObject({
      note: z.string().trim().max(120).optional(),
      maxUses: z.number().int().min(1).max(1000).optional(),
      expiresInDays: z.number().int().min(1).max(365).nullable().optional()
    }).parse(await readJson(req, 4096));
    const invite = store.createRegistrationInvite(actorId, {
      note: input.note || undefined,
      maxUses: input.maxUses,
      expiresInDays: input.expiresInDays ?? undefined
    });
    json(res, 201, { invite });
    return true;
  }

  const inviteRevoke = /^\/manage\/api\/admin\/invites\/([^/]+)\/revoke$/.exec(path);
  if (req.method === 'POST' && inviteRevoke) {
    const hashParam = codeHashParam.parse(inviteRevoke[1]);
    z.strictObject({}).parse(await readJson(req, 4096));
    if (!store.revokeRegistrationInvite(hashParam, actorId)) {
      throw new HttpError(404, 'Registration invite not found or already revoked.');
    }
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && path === '/manage/api/admin/redeem-codes') {
    json(res, 200, {
      codes: store.adminListRedeemCodes(),
      redemptions: store.adminListRedemptions()
    });
    return true;
  }

  if (req.method === 'POST' && path === '/manage/api/admin/redeem-codes') {
    const input = z.strictObject({
      tier: z.enum(redeemTiers),
      maxUses: z.number().int().min(1).max(10000).optional(),
      expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
      note: z.string().trim().max(120).optional(),
      count: z.number().int().min(1).max(20).optional()
    }).parse(await readJson(req, 4096));
    const count = input.count ?? 1;
    const codes = [];
    for (let i = 0; i < count; i++) {
      codes.push(store.createRedeemCode(actorId, {
        tier: input.tier,
        maxUses: input.maxUses,
        expiresInDays: input.expiresInDays ?? undefined,
        note: input.note || undefined
      }));
    }
    json(res, 201, { codes });
    return true;
  }

  const redeemRevoke = /^\/manage\/api\/admin\/redeem-codes\/([^/]+)\/revoke$/.exec(path);
  if (req.method === 'POST' && redeemRevoke) {
    const hashParam = codeHashParam.parse(redeemRevoke[1]);
    z.strictObject({}).parse(await readJson(req, 4096));
    if (!store.revokeRedeemCode(hashParam, actorId)) {
      throw new HttpError(404, 'Redeem code not found or already revoked.');
    }
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && path === '/manage/api/admin/devices') {
    const search = url.searchParams.get('q') ?? undefined;
    const status = url.searchParams.get('status') || undefined;
    json(res, 200, { devices: store.adminListDevices({ search, status }) });
    return true;
  }

  const deviceRevoke = /^\/manage\/api\/admin\/devices\/([^/]+)\/revoke$/.exec(path);
  if (req.method === 'POST' && deviceRevoke) {
    const deviceId = uuid.parse(deviceRevoke[1]);
    z.strictObject({}).parse(await readJson(req, 4096));
    if (!store.adminRevokeDevice(deviceId, actorId)) {
      throw new HttpError(404, 'Device is unknown or already revoked.');
    }
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && path === '/manage/api/admin/audit') {
    const search = url.searchParams.get('q') ?? undefined;
    const event = url.searchParams.get('event') || undefined;
    json(res, 200, { records: store.adminRecentAudit({ search, event }) });
    return true;
  }

  if (req.method === 'GET' && path === '/manage/api/admin/settings') {
    json(res, 200, store.getSystemPolicies(defaultResultTtlMinutes));
    return true;
  }

  if (req.method === 'POST' && path === '/manage/api/admin/settings') {
    const input = z.strictObject({
      registrationMode: z.enum(registrationModes).optional(),
      freeMonthlyQuota: z.number().int().min(1).max(10_000_000).optional(),
      resultTtlMinutes: z.number().int().min(0).max(525600).optional()
    }).refine(obj => Object.keys(obj).length > 0, 'At least one policy field is required.')
      .parse(await readJson(req, 4096));
    json(res, 200, store.updateSystemPolicies(input, actorId, defaultResultTtlMinutes));
    return true;
  }

  throw new HttpError(404, 'Not found.');
}
