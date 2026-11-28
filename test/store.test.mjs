import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, evaluateMonthlySoftQuota } from '../dist/store.js';
import { endpoint, hash, secret, syncReply } from '../dist/protocol.js';

test('store: invites, capability checks, lost responses, replacement, terminal acknowledgement and revocation', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rcm-store-'));
  const db = new Store(join(tmp, 'state.sqlite'));
  try {
    const invite = db.invite('test', ['read']);
    const credential = secret(), agent = db.pair(invite, credential);
    assert.ok(agent);
    assert.equal(db.pair(invite, secret()), undefined);
    const expired = db.invite('unused', ['read']);
    db.db.exec('UPDATE invites SET expires=0');
    assert.equal(db.pair(expired, secret()), undefined);
    assert.throws(() => db.submit(agent.id, 'dc_call', { tool: 'read_file', arguments: { path: 'file' } }), /offline/);
    const boot = randomUUID();
    db.sync(agent.id, boot, 'darwin', []);
    assert.throws(() => db.submit(agent.id, 'dc_call', { tool: 'write_file', arguments: {} }), /not paired/);
    const a = db.submit(agent.id, 'dc_call', { tool: 'read_file', arguments: { path: 'file' } });
    const b = db.submit(agent.id, 'dc_call', { tool: 'read_file', arguments: { path: 'other' } });
    const c = db.submit(agent.id, 'dc_call', { tool: 'read_file', arguments: { path: 'never' } });
    assert.equal(db.cancel(c.id).status, 'cancelled');
    let reply = db.sync(agent.id, boot, 'darwin', []);
    assert.deepEqual(new Set(reply.jobs.map(j => j.id)), new Set([a.id, b.id]));
    assert.deepEqual(db.sync(agent.id, boot, 'darwin', []), reply);
    db.sync(agent.id, boot, 'darwin', [{ id: a.id, seq: 3, status: 'running', output: 'in progress' }]);
    db.sync(agent.id, boot, 'darwin', [{ id: a.id, seq: 2, status: 'running', output: 'stale' }]);
    assert.equal(db.task(a.id).output, 'in progress');
    const done = { id: a.id, seq: 4, status: 'succeeded', output: 'done' };
    assert.deepEqual(db.sync(agent.id, boot, 'darwin', [done]).ack, [a.id]);
    assert.deepEqual(db.sync(agent.id, boot, 'darwin', [done]).ack, [a.id]);
    const newBoot = randomUUID();
    assert.deepEqual(db.sync(agent.id, newBoot, 'darwin', []).jobs, []);
    assert.equal(db.task(b.id).status, 'interrupted');
    assert.equal(db.sync(agent.id, boot, 'darwin', []), undefined);
    assert.equal(db.revoke(agent.id), true);
    assert.equal(db.deviceByToken(credential), undefined);
    const audit = JSON.stringify(db.db.prepare('SELECT * FROM audit').all());
    assert.match(audit, /task_dispatched/);
    assert.doesNotMatch(audit, /"path"|in progress|never/);
    assert.equal(audit.includes(credential), false);
    assert.equal(db.totalCalls(), 3);
    db.db.exec('UPDATE audit SET at=0');
    db.maintain();
    assert.equal(db.db.prepare('SELECT count(*) AS n FROM audit').get().n, 0);
    assert.equal(db.totalCalls(), 3);
  } finally { db.db.close(); rmSync(tmp, { recursive: true, force: true }); }
});
test('endpoint: HTTPS and explicit IPv4 loopback only', () => {
  assert.equal(endpoint('https://example.com').origin, 'https://example.com');
  assert.equal(endpoint('http://127.0.0.1:8181', true).origin, 'http://127.0.0.1:8181');
  for (const s of ['http://127.0.0.1:8181/path', 'http://example.com', 'https://x@y.com', 'https://example.com/?q=secret'])
    assert.throws(() => endpoint(s, true), /HTTPS origin/);
});

test('task history upgrade preserves existing devices and results', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rcm-history-'));
  const file = join(tmp, 'state.sqlite');
  let store = new Store(file);
  try {
    const credential = secret();
    const { id: device } = store.pair(store.invite('fixture', ['read']), credential);
    store.sync(device, randomUUID(), 'linux', []);
    const lastSeen = store.devices()[0].lastSeen;
    const task = store.submit(device, 'dc_call', { tool: 'read_file', arguments: { path: 'hello.txt' } });
    store.finish(task.id, 'succeeded', 'retained output');
    store.db.exec('ALTER TABLE tasks DROP COLUMN tool_name; ALTER TABLE tasks DROP COLUMN background; ALTER TABLE devices DROP COLUMN last_seen');
    store.db.close();

    store = new Store(file);
    assert.equal(store.deviceByToken(credential).id, device);
    assert.equal(store.devices()[0].lastSeen, lastSeen);
    assert.equal(store.view(store.task(task.id)).output, 'retained output');
    assert.deepEqual(store.backgroundCalls(10), []);
  } finally { store.db.close(); rmSync(tmp, { recursive: true, force: true }); }
});

test('unready executors hold queued tasks and an old boot cannot mark its replacement offline', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'rcm-readiness-'));
  const store = new Store(join(folder, 'gateway.sqlite'));
  try {
    const credential = secret();
    const device = store.pair(store.invite('ready-device', ['read']), credential).id;
    const oldBoot = randomUUID();
    const boot = randomUUID();
    store.sync(device, oldBoot, 'darwin', []);
    store.sync(device, boot, 'darwin', []);
    store.markOffline(device, oldBoot);
    assert.equal(store.devices()[0].online, true);

    const job = store.submit(device, 'dc_call', { tool: 'read_file', arguments: { path: 'hello.txt' } });
    assert.deepEqual(store.sync(device, boot, 'darwin', [], undefined, false).jobs, []);
    assert.equal(store.devices()[0].online, false);
    assert.ok(store.devices()[0].lastSeen);
    assert.equal(store.task(job.id).status, 'queued');
    assert.deepEqual(store.sync(device, boot, 'darwin', []).jobs.map(task => task.id), [job.id]);
    const lastSeen = store.devices()[0].lastSeen;
    store.markOffline(device, boot);
    assert.equal(store.devices()[0].online, false);
    assert.equal(store.devices()[0].lastSeen, lastSeen);
    assert.equal(store.task(job.id).status, 'interrupted');
  } finally { store.db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('unsupported stored tasks never block current Agent work or erase completed results', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rcm-unsupported-task-'));
  const store = new Store(join(folder, 'gateway.sqlite'));
  try {
    const device = store.pair(store.invite('fixture', ['read']), secret()).id;
    const boot = randomUUID();
    store.sync(device, boot, 'linux', []);
    const args = { tool: 'read_file', arguments: { path: 'hello.txt' } };
    const queued = store.submit(device, 'dc_call', args);
    const dispatched = store.submit(device, 'dc_call', args);
    const completed = store.submit(device, 'dc_call', args);
    const current = store.submit(device, 'dc_call', args);
    store.finish(completed.id, 'succeeded', 'retained');
    store.db.prepare('UPDATE tasks SET op=? WHERE id IN (?,?,?)').run('unknown_operation', queued.id, dispatched.id, completed.id);
    store.db.prepare("UPDATE tasks SET status='dispatched',boot=? WHERE id=?").run(boot, dispatched.id);

    const reply = syncReply.parse(store.sync(device, boot, 'linux', []));
    assert.equal(reply.deviceName, 'fixture');
    assert.deepEqual(reply.jobs.map(job => job.id), [current.id]);
    assert.equal(store.task(queued.id).status, 'interrupted');
    assert.equal(store.task(dispatched.id).status, 'interrupted');
    assert.equal(store.task(completed.id).output, 'retained');
  } finally { store.db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('sync includes deviceName and owner userEmail on non-fast-path responses', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rcm-sync-meta-'));
  const store = new Store(join(folder, 'gateway.sqlite'));
  try {
    const created = store.createGoogleUser({
      sub: 'sub-sync-meta',
      email: 'owner@example.com',
      displayName: 'Owner',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(created.status, 'ok');
    const device = store.pair(store.invite('macbook-pro', ['read', 'exec'], created.user.id), secret(), created.user.id).id;
    const boot = randomUUID();
    const reply = syncReply.parse(store.sync(device, boot, 'darwin', []));
    assert.equal(reply.deviceName, 'macbook-pro');
    assert.equal(reply.userEmail, 'owner@example.com');
    assert.deepEqual(reply.capabilities, ['read', 'exec']);
  } finally { store.db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('schema v1->v2 migration backfills duration_ms and desensitized usage_events', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rcm-v2-migrate-'));
  const file = join(folder, 'gateway.sqlite');
  let store = new Store(file);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
    const created = store.createGoogleUser({
      sub: 'sub-migrate-v2',
      email: 'migrate@example.com',
      displayName: 'Migrator',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(created.status, 'ok');
    const dev = store.pair(store.invite('box', ['read'], created.user.id), secret());
    store.sync(dev.id, randomUUID(), 'linux', []);
    const t = store.submit(dev.id, 'dc_call', { tool: 'read_file', arguments: { path: '/secret/top.txt' } }, created.user.id);
    store.finish(t.id, 'succeeded', 'SECRET_OUTPUT_CONTENT');

    // Simulate a v1 database snapshot before closing
    store.db.exec('DROP INDEX IF EXISTS tasks_payload_purge; DROP TABLE usage_events; ALTER TABLE tasks DROP COLUMN duration_ms; ALTER TABLE tasks DROP COLUMN payload_purged; ALTER TABLE tasks DROP COLUMN payload_purged_at; PRAGMA user_version = 1;');
    store.db.close();

    store = new Store(file);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
    const cols = store.db.prepare('PRAGMA table_info(usage_events)').all().map(c => c.name);
    assert.equal(cols.includes('args'), false);
    assert.equal(cols.includes('output'), false);
    assert.equal(cols.includes('mcp_result'), false);

    const migratedRow = store.db.prepare('SELECT * FROM usage_events WHERE task_id=?').get(t.id);
    assert.equal(migratedRow.tool_name, 'read_file');
    assert.equal(migratedRow.status, 'succeeded');
    assert.ok(migratedRow.duration_ms >= 0);
    assert.equal(store.monthlyCalls(created.user.id), 1);
  } finally { store.db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('usageAnalytics aggregates trends, tools, devices and survives task retention cleanup, plus soft quota evaluation', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rcm-usage-analytics-'));
  const store = new Store(join(folder, 'gateway.sqlite'));
  try {
    const u = store.createGoogleUser({
      sub: 'sub-usage',
      email: 'usage@example.com',
      displayName: 'Usage User',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(u.status, 'ok');
    const userId = u.user.id;
    const dev1 = store.pair(store.invite('MacBook', ['read', 'write'], userId), secret());
    const dev2 = store.pair(store.invite('Linux-VM', ['read', 'write', 'exec'], userId), secret());
    store.sync(dev1.id, randomUUID(), 'darwin', []);
    store.sync(dev2.id, randomUUID(), 'linux', []);

    const t1 = store.submit(dev1.id, 'dc_call', { tool: 'read_file', arguments: { path: 'a.txt' } }, userId);
    store.finish(t1.id, 'succeeded', 'ok-1');
    const t2 = store.submit(dev1.id, 'dc_call', { tool: 'read_file', arguments: { path: 'b.txt' } }, userId);
    store.finish(t2.id, 'failed', 'err-2');
    const t3 = store.submit(dev2.id, 'dc_call', { tool: 'write_file', arguments: { path: 'c.txt' } }, userId);
    store.finish(t3.id, 'succeeded', 'ok-3');
    const t4 = store.submit(dev2.id, 'dc_call', { tool: 'start_process', arguments: { command: 'ls' } }, userId);
    store.finish(t4.id, 'denied', 'denied-4');

    // Revoke and delete dev2 to verify distribution falls back cleanly while keeping counts
    assert.equal(store.revoke(dev2.id, userId), true);
    assert.equal(store.deleteRevokedDevice(dev2.id, userId), true);

    // Backdate t1 to 10 days ago (still in same month if now is 20th, and >7d task retention)
    const now = Date.UTC(2026, 10, 20, 12, 0, 0);
    const tenDaysAgo = now - 10 * 86400000;
    const twoMonthsAgo = Date.UTC(2026, 8, 15, 10, 0, 0);
    store.db.prepare('UPDATE tasks SET created=?, changed=?, duration_ms=? WHERE id=?').run(tenDaysAgo, tenDaysAgo + 250, 250, t1.id);
    store.db.prepare('UPDATE usage_events SET created_at=?, finished_at=?, duration_ms=? WHERE task_id=?').run(tenDaysAgo, tenDaysAgo + 250, 250, t1.id);
    store.db.prepare('UPDATE tasks SET created=?, changed=?, duration_ms=? WHERE id IN (?,?,?)').run(now - 3600000, now - 3599000, 1000, t2.id, t3.id, t4.id);
    store.db.prepare('UPDATE usage_events SET created_at=?, finished_at=?, duration_ms=? WHERE task_id IN (?,?,?)').run(now - 3600000, now - 3599000, 1000, t2.id, t3.id, t4.id);

    // Insert a historical event from 2 months ago directly into usage_events
    store.db.prepare(
      "INSERT INTO usage_events(task_id,user_id,device_id,tool_name,op,status,created_at,finished_at,duration_ms) VALUES(?,?,?,?,?,?,?,?,?)"
    ).run(randomUUID(), userId, dev1.id, 'read_file', 'dc_call', 'succeeded', twoMonthsAgo, twoMonthsAgo + 100, 100);

    // Run maintain(7): t1 should be purged from tasks, but usageAnalytics still retains it!
    store.maintain(7);
    assert.equal(store.task(t1.id, userId), undefined);

    const analytics = store.usageAnalytics(userId, { now });
    assert.equal(analytics.summary.monthCalls, 4);
    assert.equal(analytics.summary.last30dCalls, 4);
    assert.equal(analytics.summary.terminalCalls30d, 4);
    assert.equal(analytics.summary.succeededCalls30d, 2);
    assert.equal(analytics.summary.failedCalls30d, 1);
    assert.equal(analytics.summary.deniedOrCancelledCalls30d, 1);
    assert.equal(analytics.summary.successRate30d, 50);
    assert.equal(analytics.summary.avgDurationMs30d, 813);
    assert.equal(analytics.monthlyTrend.length, 6);
    assert.equal(analytics.monthlyTrend[3].month, '2026-09');
    assert.equal(analytics.monthlyTrend[3].calls, 1);
    assert.equal(analytics.monthlyTrend[5].month, '2026-11');
    assert.equal(analytics.monthlyTrend[5].calls, 4);
    assert.equal(analytics.dailyTrend.length, 30);
    assert.equal(analytics.topTools[0].toolName, 'read_file');
    assert.equal(analytics.topTools[0].calls, 2);
    assert.equal(analytics.deviceDistribution.length, 2);
    const dev2Entry = analytics.deviceDistribution.find(d => d.deviceId === dev2.id);
    assert.equal(dev2Entry.deleted, true);
    assert.equal(dev2Entry.calls, 2);
    assert.equal(dev2Entry.sharePercent, 50);

    // Soft quota evaluator boundary checks
    assert.equal(evaluateMonthlySoftQuota(10, null, now), null);
    assert.equal(evaluateMonthlySoftQuota(10, 0, now), null);
    const okQuota = evaluateMonthlySoftQuota(3, 5, now);
    assert.equal(okQuota.status, 'ok');
    assert.equal(okQuota.warning, false);
    assert.equal(okQuota.blocking, false);
    const warnQuota = evaluateMonthlySoftQuota(4, 5, now);
    assert.equal(warnQuota.status, 'warning');
    assert.equal(warnQuota.percent, 80);
    assert.equal(warnQuota.warning, true);
    assert.equal(warnQuota.blocking, false);
    assert.match(warnQuota.message, /80% soft quota/);
    const exceededQuota = evaluateMonthlySoftQuota(6, 5, now);
    assert.equal(exceededQuota.status, 'exceeded');
    assert.equal(exceededQuota.percent, 120);
    assert.equal(exceededQuota.warning, true);
    assert.equal(exceededQuota.blocking, false);
  } finally { store.db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('schema v2->v3 migration and short-lived relay payload purge preserve metadata and usage analytics', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rcm-payload-ttl-'));
  const file = join(folder, 'gateway.sqlite');
  let store = new Store(file);
  try {
    const u = store.createGoogleUser({
      sub: 'sub-ttl',
      email: 'ttl@example.com',
      displayName: 'TTL User',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(u.status, 'ok');
    const userId = u.user.id;
    const dev = store.pair(store.invite('TTL-Box', ['read', 'write'], userId), secret());
    const boot = randomUUID();
    store.sync(dev.id, boot, 'darwin', []);

    const expiredDone = store.submit(dev.id, 'dc_call', { tool: 'read_file', arguments: { path: '/secret/a.txt' } }, userId);
    store.finish(expiredDone.id, 'succeeded', 'SECRET_OUTPUT_OLD', { content: [{ type: 'text', text: 'SECRET_MCP_OLD' }] });

    const freshDone = store.submit(dev.id, 'dc_call', { tool: 'read_file', arguments: { path: '/secret/b.txt' } }, userId);
    store.finish(freshDone.id, 'succeeded', 'FRESH_OUTPUT', { content: [{ type: 'text', text: 'FRESH_MCP' }] });

    const activeTask = store.submit(dev.id, 'dc_call', { tool: 'write_file', arguments: { path: '/secret/c.txt', content: 'keep-me' } }, userId);

    // Simulate v2 DB snapshot and verify v2 -> v3 migration
    store.db.exec('DROP INDEX IF EXISTS tasks_payload_purge; ALTER TABLE tasks DROP COLUMN payload_purged; ALTER TABLE tasks DROP COLUMN payload_purged_at; PRAGMA user_version = 2;');
    store.db.close();

    store = new Store(file);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);

    const now = Date.now();
    // Backdate expiredDone to 31m ago, freshDone to 5m ago, activeTask to 40m ago (with future deadline)
    store.db.prepare('UPDATE tasks SET created=?, changed=? WHERE id=?').run(now - 31 * 60_000 - 150, now - 31 * 60_000, expiredDone.id);
    store.db.prepare('UPDATE tasks SET created=?, changed=? WHERE id=?').run(now - 5 * 60_000 - 80, now - 5 * 60_000, freshDone.id);
    store.db.prepare('UPDATE tasks SET created=?, changed=?, deadline=? WHERE id=?').run(now - 40 * 60_000, now - 40 * 60_000, now + 600_000, activeTask.id);

    // resultTtlMinutes = 0 disables early payload purge
    assert.equal(store.purgeExpiredPayloads(0, now), 0);
    assert.equal(store.task(expiredDone.id).output, 'SECRET_OUTPUT_OLD');

    // Default 30m TTL purges only expiredDone, keeping freshDone and activeTask untouched
    store.maintain(7, 90, 30, 210, 30);

    const purgedRow = store.task(expiredDone.id);
    assert.equal(purgedRow.args, '{}');
    assert.equal(purgedRow.output, null);
    assert.equal(purgedRow.mcp_result, null);
    assert.equal(purgedRow.payload_purged, 1);
    assert.ok(purgedRow.payload_purged_at > 0);

    const purgedView = store.view(purgedRow);
    assert.equal(purgedView.payloadPurged, true);
    assert.ok(purgedView.payloadPurgedAt);
    assert.equal(purgedView.output, null);
    assert.equal(Object.hasOwn(purgedView, 'result'), false);
    assert.equal(purgedView.toolName, 'read_file');
    assert.equal(purgedView.status, 'succeeded');
    assert.ok(purgedView.durationMs >= 0);

    const freshView = store.view(store.task(freshDone.id));
    assert.equal(freshView.payloadPurged, false);
    assert.equal(freshView.output, 'FRESH_OUTPUT');
    assert.equal(freshView.result.content[0].text, 'FRESH_MCP');

    const activeRow = store.task(activeTask.id);
    assert.equal(activeRow.payload_purged, 0);
    assert.match(activeRow.args, /keep-me/);

    // Metadata & usage analytics remain completely intact after payload purge
    assert.equal(store.monthlyCalls(userId), 3);
    const analytics = store.usageAnalytics(userId);
    assert.equal(analytics.summary.monthCalls, 3);
    assert.equal(analytics.summary.succeededCalls30d, 2);
  } finally { store.db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('schema v3->v4 migration, billable monthly metering, redeem codes, idempotency, stacking, and expiry downgrade', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rcm-plan-quota-'));
  const file = join(folder, 'gateway.sqlite');
  let store = new Store(file);
  try {
    const adminRes = store.createGoogleUser({
      sub: 'sub-plan-admin',
      email: 'plan-admin@example.com',
      displayName: 'Plan Admin',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(adminRes.status, 'ok');
    store.setRegistrationMode('open');
    const freeRes = store.createGoogleUser({
      sub: 'sub-plan-free',
      email: 'plan-free@example.com',
      displayName: 'Free User',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(freeRes.status, 'ok');
    assert.equal(freeRes.user.plan, 'free');
    const freeId = freeRes.user.id;
    const dev = store.pair(store.invite('Free-Box', ['read', 'write', 'exec'], freeId), secret());
    store.sync(dev.id, randomUUID(), 'linux', []);

    // Billable metering: succeeded & failed dc_call count once; denied/cancelled/timed_out/disconnect do not
    const tSucc = store.submit(dev.id, 'dc_call', { tool: 'read_file', arguments: { path: 'a.txt' } }, freeId);
    store.finish(tSucc.id, 'succeeded', 'ok');
    store.finish(tSucc.id, 'succeeded', 'duplicate'); // duplicate finish does not double-bill
    const tFail = store.submit(dev.id, 'dc_call', { tool: 'read_file', arguments: { path: 'missing.txt' } }, freeId);
    store.finish(tFail.id, 'failed', 'ENOENT');
    const tDeny = store.submit(dev.id, 'dc_call', { tool: 'write_file', arguments: { path: 'x.txt', content: '1' } }, freeId);
    store.finish(tDeny.id, 'denied', 'denied');
    const tCancel = store.submit(dev.id, 'dc_call', { tool: 'read_file', arguments: { path: 'c.txt' } }, freeId);
    store.cancel(tCancel.id, freeId);
    const tDisc = store.submit(dev.id, 'disconnect', {}, freeId);
    store.finish(tDisc.id, 'succeeded', 'bye');

    assert.equal(store.billableMonthlyCalls(freeId), 2);

    // Simulate v3 DB and verify v3 -> v4 migration backfills usage_monthly
    store.db.exec('DELETE FROM usage_monthly; PRAGMA user_version = 3;');
    store.db.close();
    store = new Store(file);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(store.billableMonthlyCalls(freeId), 2);

    // Next UTC month automatically resets billableMonthlyCalls to 0
    const now = Date.now();
    const d = new Date(now);
    const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 2);
    assert.equal(store.billableMonthlyCalls(freeId, nextMonth), 0);

    // Quota status thresholds at 80% and 100%
    store.db.prepare('UPDATE users SET custom_monthly_quota=2 WHERE id=?').run(freeId);
    const exceeded = store.getUserPlanStatus(freeId, now);
    assert.equal(exceeded.status, 'exceeded');
    assert.equal(exceeded.exceeded, true);
    assert.equal(exceeded.remaining, 0);

    // Create & redeem monthly + quarterly stacking, single-use exhaustion, idempotency, revoke, lifetime & downgrade
    const monthCode = store.createRedeemCode(adminRes.user.id, { tier: 'monthly', maxUses: 1, note: 'month' });
    const quarterCode = store.createRedeemCode(adminRes.user.id, { tier: 'quarterly', maxUses: 1 });
    const revokedCode = store.createRedeemCode(adminRes.user.id, { tier: 'monthly', maxUses: 1 });
    assert.equal(store.revokeRedeemCode(hash(revokedCode.code), adminRes.user.id), true);
    assert.equal(store.redeemProCode(freeId, revokedCode.code, now).status, 'revoked');
    assert.equal(store.redeemProCode(freeId, 'PRO-NOPE-00000-00000', now).status, 'invalid');

    const r1 = store.redeemProCode(freeId, monthCode.code.toLowerCase(), now);
    assert.equal(r1.status, 'ok');
    assert.equal(r1.tier, 'monthly');
    assert.equal(r1.planQuota.plan, 'pro');
    assert.equal(r1.planQuota.status, 'unlimited');
    assert.equal(store.redeemProCode(freeId, monthCode.code, now).status, 'already_redeemed');

    // Second user cannot consume single-use exhausted code
    const secondRes = store.createGoogleUser({
      sub: 'sub-plan-second',
      email: 'plan-second@example.com',
      displayName: 'Second User',
      avatarUrl: null,
      adminEmails: new Set()
    });
    assert.equal(store.redeemProCode(secondRes.user.id, monthCode.code, now).status, 'exhausted');

    // Stacking quarterly on top of active monthly extends by 90 days
    const r2 = store.redeemProCode(freeId, quarterCode.code, now);
    assert.equal(r2.status, 'ok');
    const expectedStacked = now + (30 + 90) * 86400000;
    assert.equal(new Date(r2.planQuota.planExpiresAt).getTime(), expectedStacked);

    // Expiry triggers automatic downgrade back to Free
    const afterExpiry = expectedStacked + 1000;
    const downgraded = store.getUserPlanStatus(freeId, afterExpiry);
    assert.equal(downgraded.plan, 'free');
    assert.equal(downgraded.planExpiresAt, null);
    assert.equal(store.recentAudit(10, freeId).some(a => a.event === 'plan_expired_downgraded'), true);

    // Lifetime Pro refuses timed codes without wasting them
    const lifeCode = store.createRedeemCode(adminRes.user.id, { tier: 'lifetime', maxUses: 1 });
    const extraMonth = store.createRedeemCode(adminRes.user.id, { tier: 'monthly', maxUses: 1 });
    const rLife = store.redeemProCode(freeId, lifeCode.code, afterExpiry);
    assert.equal(rLife.status, 'ok');
    assert.equal(rLife.planQuota.planExpiresAt, null);
    assert.equal(store.redeemProCode(freeId, extraMonth.code, afterExpiry).status, 'already_lifetime');
    // extraMonth wasn't wasted, so secondRes can still redeem it
    assert.equal(store.redeemProCode(secondRes.user.id, extraMonth.code, afterExpiry).status, 'ok');

    // grantUserPlan extension point downgrades or extends cleanly
    const granted = store.grantUserPlan(secondRes.user.id, { plan: 'free', source: 'webhook_cancel', externalRef: 'sub_123', now: afterExpiry });
    assert.equal(granted.plan, 'free');
    assert.equal(store.userRedemptions(freeId, 10).length, 3);
    // Ensure plaintext codes never appear in audit logs
    const auditText = JSON.stringify(store.recentAudit(50));
    assert.equal(auditText.includes(monthCode.code), false);
    assert.equal(auditText.includes(lifeCode.code), false);
  } finally { store.db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('Store admin governance covers overview, users, sessions, plans, codes, fleet devices, audit, and live policies', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rcm-admin-store-'));
  const store = new Store(join(folder, 'gateway.sqlite'));
  try {
    const admin = store.createGoogleUser({
      sub: 'sub-adm',
      email: 'admin@example.com',
      displayName: 'Admin',
      avatarUrl: null,
      adminEmails: new Set()
    }).user;
    store.setRegistrationMode('open', admin.id);
    const bob = store.createGoogleUser({
      sub: 'sub-bob',
      email: 'bob@example.com',
      displayName: 'Bob',
      avatarUrl: null,
      adminEmails: new Set()
    }).user;

    store.putAuth(secret(), 'dashboard', 3600000, { csrf: secret(), userId: bob.id, role: bob.role });
    store.putAuth(secret(), 'access', 3600000, { userId: bob.id, clientId: 'c1' });
    const devBob = store.pair(store.invite('Bob-PC', ['read'], bob.id), secret());
    store.sync(devBob.id, randomUUID(), 'win32', []);

    const inv = store.createRegistrationInvite(admin.id, { note: 'team', maxUses: 2 });
    const red = store.createRedeemCode(admin.id, { tier: 'monthly', maxUses: 1, note: 'promo' });

    const ov = store.adminOverview();
    assert.equal(ov.users.total, 2);
    assert.equal(ov.devices.online, 1);
    assert.equal(ov.codes.activeInvites, 1);
    assert.equal(ov.codes.activeRedeemCodes, 1);

    const listedUsers = store.adminListUsers({ search: 'bob' });
    assert.equal(listedUsers.length, 1);
    assert.equal(listedUsers[0].deviceCount, 1);

    assert.throws(() => store.adminSetUserStatus(admin.id, 'disabled', admin.id), /Cannot disable your own/);
    const disabled = store.adminSetUserStatus(bob.id, 'disabled', admin.id);
    assert.equal(disabled.user.status, 'disabled');
    assert.equal(disabled.revokedSessions, 2);
    assert.equal(store.adminSetUserStatus(bob.id, 'active', admin.id).user.status, 'active');

    store.putAuth(secret(), 'dashboard', 3600000, { csrf: secret(), userId: bob.id, role: bob.role });
    assert.equal(store.adminForceLogoutUser(bob.id, admin.id).revokedSessions, 1);

    const updatedPlan = store.adminUpdateUserPlan(bob.id, { plan: 'pro', durationDays: 30, customMonthlyQuota: 50000 }, admin.id);
    assert.equal(updatedPlan.plan, 'pro');
    assert.ok(updatedPlan.planExpiresAt);
    assert.equal(store.findUserById(bob.id).customMonthlyQuota, 50000);

    const invites = store.adminListRegistrationInvites();
    assert.equal(invites.length, 1);
    assert.equal(store.revokeRegistrationInvite(invites[0].codeHash, admin.id), true);
    assert.equal(store.adminListRegistrationInvites()[0].revoked, true);

    assert.equal(store.redeemProCode(bob.id, red.code).status, 'ok');
    assert.equal(store.adminListRedeemCodes().length, 1);
    assert.equal(store.adminListRedemptions().length, 1);

    const fleet = store.adminListDevices({ status: 'online' });
    assert.equal(fleet.length, 1);
    assert.equal(fleet[0].ownerEmail, 'bob@example.com');
    assert.equal(store.adminRevokeDevice(devBob.id, admin.id), true);
    assert.equal(store.devices(bob.id)[0].revoked, true);

    const policies = store.updateSystemPolicies({ registrationMode: 'closed', freeMonthlyQuota: 20000, resultTtlMinutes: 12 }, admin.id, 30);
    assert.deepEqual(policies, { registrationMode: 'closed', freeMonthlyQuota: 20000, resultTtlMinutes: 12 });
    assert.equal(store.getResultTtlMinutes(30), 12);

    const globalAudit = store.adminRecentAudit({ search: 'admin_' });
    assert.equal(globalAudit.some(r => r.event === 'admin_device_revoked'), true);
    assert.equal(globalAudit.some(r => r.event === 'admin_system_policies_updated'), true);
  } finally { store.db.close(); rmSync(folder, { recursive: true, force: true }); }
});
