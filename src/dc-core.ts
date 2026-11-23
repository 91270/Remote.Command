import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const [mode, output] = process.argv.slice(2);
const catalogOutput = output ? resolve(output) : undefined;
const privateState = process.env.PRM_CORE_STATE;
if (!privateState || !isAbsolute(privateState)) {
  throw new Error('Set PRM_CORE_STATE to the private state directory assigned by the Agent.');
}
await mkdir(privateState, { recursive: true, mode: 0o700 });
const workspace = await realpath(process.env.PRM_WORKSPACE ?? process.cwd());
process.chdir(workspace);
process.env.PRM_WORKSPACE = workspace;
process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
process.env.DC_REMOTE_DEVICE = 'true';
(globalThis as Record<string, unknown>).disableOnboarding = true;
const coreUrl = new URL('../vendor/desktop-commander-full/', import.meta.url);
const coreImport = (file: string): Promise<any> => import(new URL(file, coreUrl).href);
const { configManager } = await coreImport('config-manager.js');
await configManager.loadConfig();
async function scopedDirectories(value: unknown): Promise<string[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error('allowedDirectories must contain one or more directories within the Agent workspace.');
  }
  const locations: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !isAbsolute(entry)) throw new Error('Use absolute workspace directories.');
    const location = await realpath(entry);
    const suffix = relative(workspace, location);
    if (suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix) || !(await stat(location)).isDirectory()) {
      throw new Error('allowedDirectories must point to directories within the workspace assigned locally to this Agent.');
    }
    locations.push(location);
  }
  return locations;
}
const saved = await configManager.getConfig();
const directories = await scopedDirectories(saved.allowedDirectories).catch(() => [workspace]);
await configManager.setValue('allowedDirectories', directories);
await configManager.setValue('telemetryEnabled', false);
const originalSetValue = configManager.setValue.bind(configManager);
configManager.setValue = async (key: string, value: unknown, options?: unknown) => {
  if (key === 'telemetryEnabled' && value !== false) throw new Error('Telemetry is disabled in this independent deployment.');
  if (key === 'allowedDirectories') value = await scopedDirectories(value);
  return originalSetValue(key, value, options);
};
const { server, flushDeferredMessages } = await coreImport('server.js');
const { preloadFileSupport } = await coreImport('utils/files/index.js');
const { terminalManager } = await coreImport('terminal-manager.js');
const { searchManager } = await coreImport('search-manager.js');
let closing: Promise<void> | undefined;
const cleanup = () => closing ??= (async () => {
  searchManager.dispose();
  const sessions = terminalManager.listActiveSessions() as { pid: number }[];
  await Promise.allSettled(sessions.map(session => terminalManager.forceTerminate(session.pid)));
})();

if (mode === '--catalog') {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'private-remote-catalog', version: '0.2.0' });
  await client.connect(clientTransport);
  const [tools, resources] = await Promise.all([client.listTools(), client.listResources()]);
  const catalogTools = tools.tools.map(tool => tool.name === 'start_process' ? {
    ...tool,
    description: tool.description?.replace(/Running on[\s\S]*?(?=Examples:)/,
      'The process runs on the selected device. Call get_config for its operating system and default shell.\n\n                        ')
  } : tool);
  const catalog = JSON.stringify({ version: '0.3.3', tools: catalogTools, resources: resources.resources }, null, 2) + '\n';
  if (catalogOutput) await writeFile(catalogOutput, catalog, { mode: 0o600 });
  else process.stdout.write(catalog);
  await client.close();
  await cleanup();
  process.exit(0);
} else {
  const { FilteredStdioServerTransport } = await coreImport('custom-stdio.js');
  const transport = new FilteredStdioServerTransport();
  (globalThis as Record<string, unknown>).mcpTransport = transport;
  server.oninitialized = () => {
    transport.enableNotifications();
    flushDeferredMessages();
    preloadFileSupport();
  };
  await server.connect(transport);
  const originalClose = server.onclose;
  server.onclose = async () => {
    originalClose?.();
    await cleanup();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void cleanup().finally(async () => {
        await server.close();
        process.exit(0);
      });
    });
  }
}
