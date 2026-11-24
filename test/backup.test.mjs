import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../dist/store.js';
import { hash, secret } from '../dist/protocol.js';

test('online SQLite backup, verification and recovery without overwriting a live database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcm-backup-test-'));
  const original = join(dir, 'live.sqlite');
  const restored = join(dir, 'new.sqlite');
  const store = new Store(original);
  const run = (cmd, db, input) => spawnSync(process.execPath, ['dist/admin.js', cmd], {
    env: { ...process.env, STATE_DB: db }, input, timeout: 10000
  });
  try {
    const token = secret();
    const device = store.pair(store.invite('source device', ['read']), token).id;
    store.invite('unused invite', ['read']);
    store.db.prepare('INSERT INTO auth VALUES(?,?,?,?)').run(hash(secret()), 'access', Date.now() + 60000, '{}');
    store.sync(device, randomUUID(), 'linux', []);
    const done = store.submit(device, 'dc_call', { tool: 'read_file', arguments: { path: 'hello.txt' } });
    const active = store.submit(device, 'dc_call', { tool: 'read_file', arguments: { path: 'pending.txt' } });
    store.finish(done.id, 'succeeded', 'retained output');

    const backup = run('backup', original);
    assert.equal(backup.status, 0, backup.stderr.toString());
    assert.ok(backup.stdout.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')));
    assert.equal(run('verify-backup', original, backup.stdout).status, 0);
    assert.equal(run('restore', original, backup.stdout).status, 1);
    assert.equal(run('restore', restored, Buffer.from('corrupt')).status, 1);
    assert.equal(existsSync(restored), false);
    const restore = run('restore', restored, backup.stdout);
    assert.equal(restore.status, 0, restore.stderr.toString());
    const bytes = readFileSync(restored);
    assert.equal(run('restore', restored, backup.stdout).status, 1);
    assert.deepEqual(readFileSync(restored), bytes);

    const recovered = new Store(restored);
    try {
      assert.equal(recovered.task(done.id).output, 'retained output');
      assert.equal(recovered.task(active.id).status, 'interrupted');
      assert.equal(recovered.deviceByToken(token), undefined);
      assert.equal(recovered.devices()[0].revoked, true);
      assert.equal(recovered.devices()[0].lastSeen, store.devices()[0].lastSeen);
      assert.equal(recovered.db.prepare('SELECT count(*) AS n FROM auth').get().n, 0);
      assert.equal(recovered.db.prepare('SELECT count(*) AS n FROM invites').get().n, 0);
      assert.equal(store.deviceByToken(token).id, device);
      assert.equal(store.task(active.id).status, 'queued');
    } finally { recovered.db.close(); }
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
