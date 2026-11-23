import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceFlow } from '../dist/device-flow.js';
import { Store } from '../dist/store.js';
import { hash, secret } from '../dist/protocol.js';

test('browser device pairing binds PKCE and a one-time owner decision to the device credential', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'prm-device-flow-'));
  const store = new Store(join(folder, 'gateway.sqlite'));
  const flow = new DeviceFlow(store, 'https://private.example.com');
  const proof = secret(), credential = secret();
  const permitPoll = code => {
    const row = store.db.prepare('SELECT data FROM auth WHERE digest=?').get(hash(code));
    const data = JSON.parse(row.data);
    data.lastPoll = 0;
    store.db.prepare('UPDATE auth SET data=? WHERE digest=?').run(JSON.stringify(data), hash(code));
  };
  try {
    const offer = flow.start('workstation', hash(proof));
    assert.equal(flow.poll(offer.device_code, secret(), credential).error, 'invalid_grant');
    assert.equal(flow.poll(offer.device_code, proof, credential).error, 'authorization_pending');
    assert.equal(flow.poll(offer.device_code, proof, credential).error, 'slow_down');
    assert.equal(flow.verify(offer.user_code.toLowerCase(), undefined, ['read', 'exec'], true).status, 'approved');
    assert.throws(() => flow.verify(offer.user_code, undefined, ['write'], true), /already/);
    permitPoll(offer.device_code);
    const accepted = flow.poll(offer.device_code, proof, credential);
    assert.ok(accepted.device_id);
    assert.equal(store.deviceByToken(credential).id, accepted.device_id);
    // If the successful HTTP response is lost, only the original verifier and
    // the exact credential can recover it. No duplicate device is created.
    permitPoll(offer.device_code);
    assert.deepEqual(flow.poll(offer.device_code, proof, credential), accepted);
    permitPoll(offer.device_code);
    assert.equal(flow.poll(offer.device_code, proof, secret()).error, 'invalid_grant');
    assert.equal(store.devices().length, 1);
    const denied = flow.start('denied', hash(proof));
    flow.verify(denied.user_code, 'declined', ['read'], false);
    assert.equal(flow.poll(denied.device_code, proof, credential).error, 'access_denied');
    const expired = flow.start('expired', hash(proof));
    store.db.prepare('UPDATE auth SET expires=0 WHERE digest=?').run(hash(expired.device_code));
    assert.equal(flow.poll(expired.device_code, proof, credential).error, 'expired_token');
    const audit = JSON.stringify(store.db.prepare('SELECT * FROM audit').all());
    assert.ok(!audit.includes(credential) && !audit.includes(proof) && !audit.includes(offer.device_code));
  } finally { store.db.close(); await rm(folder, { recursive: true, force: true }); }
});
