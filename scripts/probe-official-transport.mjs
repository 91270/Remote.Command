import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [artifact, output] = process.argv.slice(2);
if (!artifact) throw new Error('Pass the extracted official 0.3.4 package and an optional JSON output path.');
const modulePath = 'dist/remote-device/remote-channel.js';
const original = await readFile(join(resolve(artifact), modulePath), 'utf8');
const sha256 = createHash('sha256').update(original).digest('hex');
assert.equal(sha256, '4d5aa2f5e9f74043587496a7b57a223d200992855a4db8ae150e0b68567c7fec');

let imports = 0;
const body = original.replace(/^import .*;\r?\n/gm, () => { imports++; return ''; });
assert.equal(imports, 8);
const stubs = `
  const captureRemote = async () => {};
  const observeTransport = () => {};
  const createClient = () => { throw new Error('Network client disabled in probe'); };
  const enrollMqttDevice = createClient;
  const MqttTransport = createClient;
  const RealtimeHealthTelemetry = class {};
  const VERSION = '0.3.4';
  let mqtt = false;
  const rolloutManager = { get: (name) => name === 'MQTT_TRANSPORT_ENABLED' && mqtt };
  export const setRollout = value => { mqtt = value; };
`;
const { RemoteChannel, setRollout } = await import('data:text/javascript;base64,' + Buffer.from(stubs + body).toString('base64'));
const channel = new RemoteChannel();
const savedConsole = Object.fromEntries(['debug', 'error', 'warn', 'log'].map(key => [key, console[key]]));
const savedFetch = globalThis.fetch;
const timeline = [];

try {
  globalThis.fetch = () => { throw new Error('Network access disabled in probe'); };
  for (const key of Object.keys(savedConsole)) console[key] = () => {};
  const notice = { call_id: 'probe-call', device_id: 'probe-device', IS_MQTT_EXECUTION_ENABLED: true };
  channel.onDoorbell = async payload => timeline.push(['dispatch', payload.call_id]);
  await channel.onMqttDoorbell(notice);
  assert.deepEqual(timeline, []);
  await channel.onBroadcastDoorbell(notice);
  assert.deepEqual(timeline.splice(0), [['dispatch', 'probe-call']]);
  channel.sessionLost = true;
  await channel.onBroadcastDoorbell(notice);
  assert.deepEqual(timeline, []);
  channel.sessionLost = false;

  channel.channel = { state: 'joined' };
  channel.channelReady = true;
  channel.localExecutorProbe = () => true;
  channel.mqttReady = false;
  assert.equal(channel.isReachable(), true);
  for (const [key, missing, present] of [['channel', { state: 'joining' }, { state: 'joined' }],
    ['channelReady', false, true], ['localExecutorProbe', () => false, () => true]]) {
    channel[key] = missing;
    assert.equal(channel.isReachable(), false);
    channel[key] = present;
  }

  channel.prepareMqttConfig = async () => { timeline.push(['enroll']); return {}; };
  channel.startMqttTransport = async () => { timeline.push(['connect']); };
  await channel.startMqtt();
  assert.deepEqual(timeline, []);
  setRollout(true);
  await channel.startMqtt();
  assert.deepEqual(timeline.splice(0), [['enroll'], ['connect']]);
  channel.prepareMqttConfig = async () => { timeline.push(['enroll']); setRollout(false); return {}; };
  await channel.startMqtt();
  assert.deepEqual(timeline.splice(0), [['enroll']]);

  let rejectResult = false;
  channel.client = {
    from: table => ({ update: fields => ({ eq: async (key, id) => {
      assert.equal(table, 'mcp_remote_calls');
      assert.equal(key, 'id');
      assert.equal(id, 'probe-call');
      timeline.push(['write', fields]);
      if (rejectResult) { rejectResult = false; return { error: { message: 'fixture rejected rich output' } }; }
      return { error: null };
    } }) })
  };
  channel.mqttReceiver = { publishResult: async (id, instance) => timeline.push(['notify', id, instance]) };
  await channel.updateCallResult('probe-call', 'completed', { content: [{ type: 'text', text: 'a\0b' }] }, null, 'fixture-instance');
  assert.deepEqual(timeline.splice(0), [
    ['write', { status: 'completed', result: { content: [{ type: 'text', text: 'ab' }] } }],
    ['notify', 'probe-call', 'fixture-instance']
  ]);
  rejectResult = true;
  await channel.updateCallResult('probe-call', 'completed', { content: [] }, null, 'fixture-instance');
  assert.deepEqual(timeline.splice(0), [
    ['write', { status: 'completed', result: { content: [] } }],
    ['write', { status: 'failed', error_message: 'Result could not be stored (fixture rejected rich output)' }],
    ['notify', 'probe-call', 'fixture-instance']
  ]);
} finally {
  Object.assign(console, savedConsole);
  globalThis.fetch = savedFetch;
}

const result = {
  artifact: '@wonderwhy-er/desktop-commander@0.3.4', module: modulePath, sha256,
  checks: ['broadcastEntersDispatch', 'mqttReceiptDoesNotEnterDispatch', 'sessionLossStopsDispatch',
    'readinessIndependentOfMqtt', 'mqttRolloutCheckedBeforeAndAfterEnrollment',
    'resultWriteBeforeNotification', 'nulRemovedFromResult', 'richWriteFailureUsesTextFallback'],
  scope: 'Shipped RemoteChannel source. Network and logging imports stubbed, dispatch boundary and storage replaced by in-process fixtures. No official sessions, endpoints, sockets or databases used.'
};
if (output) await writeFile(resolve(output), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
