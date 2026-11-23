import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// Run the official shipped authentication class against injected in-memory
// responses. Only imports with official service side effects are replaced.
// No requests are sent to the official authentication or messaging services.
const [artifactPath, outputPath] = process.argv.slice(2);
if (!artifactPath) throw new Error('Pass the extracted official npm package directory and an optional JSON output path.');
const root = resolve(artifactPath);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@wonderwhy-er/desktop-commander');
const file = join(root, 'dist/remote-device/device-authenticator.js');
const source = await readFile(file, 'utf8');
const sha256 = createHash('sha256').update(source).digest('hex');
assert.equal(sha256, '5bbeb50e65018480a698dcaa85548939aef8412783b41b88abfa849adbce79be');
const harness = source
  .replace("import open from 'open';", 'const open = async () => {};')
  .replace("import { captureRemote } from '../utils/capture.js';", 'const captureRemote = async () => {};')
  .replace("import { observeServerDate } from './remote-channel.js';", 'const observeServerDate = () => {};');
assert.notEqual(harness, source);
const { DeviceAuthenticator } = await import('data:text/javascript;base64,' + Buffer.from(harness).toString('base64'));
const requests = [], sleeps = [];
let replyIndex = 0;
const answers = [
  { status: 400, body: { error: 'authorization_pending' } },
  { status: 400, body: { error: 'slow_down' } },
  { status: 502, body: null },
  { status: 200, body: { device_id: 'fixture-device', access_token: 'fixture-access', refresh_token: 'fixture-refresh' } }
];
const client = new DeviceAuthenticator('https://fixture.invalid', {
  capture: async () => {}, open: async () => {},
  fetch: async (url, init) => {
    requests.push({ url, redirect: init.redirect, body: JSON.parse(init.body) });
    if (url.endsWith('/device/start')) {
      return Response.json({ device_code: 'fixture-code', user_code: 'ABCDE', verification_uri_complete: 'https://fixture.invalid/verify-device',
        expires_in: 60, interval: 1 });
    }
    const answer = answers[replyIndex++];
    return Response.json(answer.body, { status: answer.status });
  }
});
client.sleep = async ms => { sleeps.push(ms); };
const originalLog = console.log;
console.log = () => {};
let grant, result;
try {
  const pkce = client.generatePKCE();
  assert.equal(pkce.verifier.length, 43);
  assert.equal(pkce.challenge, createHash('sha256').update(pkce.verifier).digest('base64url'));
  grant = await client.requestDeviceCode(pkce.challenge);
  result = await client.pollForAuthorization(grant, pkce.verifier);
  assert.equal(result.device_id, 'fixture-device');
  assert.equal(result.refresh_token, 'fixture-refresh');
  assert.equal(requests.length, 5);
  assert.equal(sleeps.length, 5);
  assert.ok(requests.every(request => request.redirect === 'error'));
  assert.ok(requests.slice(1).every(request => request.body.code_verifier === pkce.verifier));
  const rejected = new DeviceAuthenticator('https://fixture.invalid', {
    capture: async () => {}, fetch: async () => Response.json({ error: 'access_denied' }, { status: 400 })
  });
  rejected.sleep = async () => {};
  await assert.rejects(() => rejected.pollForAuthorization(grant, pkce.verifier), /access_denied/);
} finally { console.log = originalLog; }
const report = {
  generatedAt: new Date().toISOString(), artifact: `${manifest.name}@${manifest.version}`,
  module: 'dist/remote-device/device-authenticator.js', sha256,
  method: 'Official shipped class with side-effect imports stubbed and fetch/open/capture dependencies injected.',
  checks: { s256Pkce: 'passed', deviceStart: 'passed', pendingRetry: 'passed', slowDownRetry: 'passed',
    http502Retry: 'passed', tokenResult: 'passed', accessDeniedTerminal: 'passed', redirectError: 'passed' },
  observedRequests: requests.map(request => ({ path: new URL(request.url).pathname, redirect: request.redirect, fields: Object.keys(request.body) })),
  sleepIntervals: sleeps,
  limitations: ['Offline injected responses. The official cloud service, refresh-token backend and MQTT connection were not executed.']
};
if (outputPath) await writeFile(resolve(outputPath), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
