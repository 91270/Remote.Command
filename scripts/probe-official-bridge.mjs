import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [artifact, output] = process.argv.slice(2);
if (!artifact) throw new Error('Pass the extracted official npm package directory and an optional JSON output path.');
const root = resolve(artifact);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@wonderwhy-er/desktop-commander');
const modulePath = 'dist/remote-device/desktop-commander-integration.js';
const original = await readFile(join(root, modulePath), 'utf8');
const sha256 = createHash('sha256').update(original).digest('hex');
assert.equal(sha256, '7231a403268873bb924219381919190ab0b789134fb05ba7ae3b818cb519ccd7');
const target = await mkdtemp(join(tmpdir(), 'rcm-official-bridge-'));
const bridgeFile = join(target, modulePath);
const childFile = join(target, 'dist', 'index.js');
const sdk = entry => JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/' + entry));

let bridge;
const savedConsole = Object.fromEntries(['log', 'debug', 'error', 'warn'].map(type => [type, console[type]]));
try {
  await mkdir(dirname(bridgeFile), { recursive: true });
  await writeFile(join(target, 'package.json'), '{"type":"module"}');
  await writeFile(bridgeFile, original
    .replace("'@modelcontextprotocol/sdk/client/index.js'", sdk('client/index.js'))
    .replace("'@modelcontextprotocol/sdk/client/stdio.js'", sdk('client/stdio.js'))
    .replace("import { captureRemote } from '../utils/capture.js';", 'const captureRemote = async () => {};')
    .replace("import { resolveShellPath } from '../utils/shell.js';", 'const resolveShellPath = () => undefined;'));
  await writeFile(childFile, `
    import { Server } from ${sdk('server/index.js')};
    import { StdioServerTransport } from ${sdk('server/stdio.js')};
    import { ListToolsRequestSchema, CallToolRequestSchema } from ${sdk('types.js')};
    const server = new Server({ name: 'bridge-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
      { name: 'probe', inputSchema: { type: 'object' } },
      { name: 'exit_fixture', inputSchema: { type: 'object' } }
    ] }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
      if (params.name === 'exit_fixture') process.exit(23);
      return { content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }],
        structuredContent: {
          pid: process.pid, args: params.arguments, remote: params._meta?.remote,
          marker: params._meta?.marker, remoteDevice: process.env.DC_REMOTE_DEVICE
        }
      };
    });
    await server.connect(new StdioServerTransport());
  `);

  for (const type of Object.keys(savedConsole)) console[type] = () => {};
  const { DesktopCommanderIntegration } = await import(pathToFileURL(bridgeFile).href);
  bridge = new DesktopCommanderIntegration();
  let disconnects = 0;
  bridge.onDisconnect(() => { disconnects++; });
  await bridge.initialize();
  assert.equal(bridge.ready, true);
  assert.deepEqual((await bridge.listClientTools()).tools.map(tool => tool.name), ['probe', 'exit_fixture']);

  const first = await bridge.callClientTool('probe', { value: 'fixture' }, { marker: 'fixture-metadata' });
  assert.deepEqual(first.content, [{ type: 'image', mimeType: 'image/png', data: 'AA==' }]);
  assert.deepEqual(first.structuredContent, {
    pid: first.structuredContent.pid, args: { value: 'fixture' }, remote: true, marker: 'fixture-metadata', remoteDevice: 'true'
  });
  assert.ok(first.structuredContent.pid > 0);
  await assert.rejects(() => bridge.callClientTool('exit_fixture', {}), /closed/i);
  assert.equal(bridge.ready, false);
  assert.equal(disconnects, 1);

  const recovered = await Promise.all([
    bridge.callClientTool('probe', { value: 'first' }),
    bridge.callClientTool('probe', { value: 'second' })
  ]);
  assert.notEqual(recovered[0].structuredContent.pid, first.structuredContent.pid);
  assert.equal(recovered[0].structuredContent.pid, recovered[1].structuredContent.pid);
  assert.equal(bridge.ready, true);

  await bridge.shutdown();
  assert.equal(bridge.ready, false);
  await assert.rejects(() => bridge.callClientTool('probe', {}), /shutting down/i);
  assert.equal(disconnects, 1);
} finally {
  if (bridge?.ready) await bridge.shutdown();
  Object.assign(console, savedConsole);
  await rm(target, { recursive: true, force: true });
}

const report = {
  generatedAt: new Date().toISOString(),
  artifact: `${manifest.name}@${manifest.version}`,
  module: modulePath,
  sha256,
  checks: {
    realStdioDiscovery: 'passed',
    inputAndMetadataForwarding: 'passed',
    imageAndStructuredResult: 'passed',
    inFlightChildExit: 'passed',
    singleRestartForConcurrentCalls: 'passed',
    noRestartAfterIntentionalShutdown: 'passed'
  },
  limitations: [
    'The shipped bridge started an isolated local MCP fixture through its normal development-path resolver.',
    'Official telemetry and fallback lookup of an existing installation were stubbed. This probe did not connect to a hosted backend.'
  ]
};
if (output) await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
