import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] ?? '/private/tmp/remote-command-audit-npm');
const destination = join(project, 'vendor', 'desktop-commander-full');
const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
if (metadata.name !== '@wonderwhy-er/desktop-commander' || metadata.version !== '0.3.3') {
  throw new Error('The source must be the unmodified @wonderwhy-er/desktop-commander 0.3.3 published package.');
}
await mkdir(destination, { recursive: true });
for (const dir of ['handlers', 'tools', 'utils', 'ui', 'data']) {
  await cp(join(source, 'dist', dir), join(destination, dir), { recursive: true });
}
for (const file of await readdir(join(source, 'dist'))) {
  if (file.endsWith('.js') && !['index.js', 'setup-claude-server.js', 'uninstall-claude-server.js', 'track-installation.js'].includes(file)) {
    await cp(join(source, 'dist', file), join(destination, file));
  }
}
await cp(join(source, 'LICENSE'), join(destination, 'LICENSE'));
async function patch(file, transform) {
  const path = join(destination, file);
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (before === after) throw new Error('Patch did not apply to ' + file);
  await writeFile(path, after);
}
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith('.js')) {
      const s = await readFile(path, 'utf8');
      await writeFile(path, s.replace(/from (['"])zod\1/g, 'from "zod3"'));
    }
  }
}
await walk(destination);
await patch('config.js', s => s.replace("const CONFIG_DIR = path.join(USER_HOME, '.claude-server-commander');",
  "const CONFIG_DIR = process.env.PRM_CORE_STATE;\nif (!CONFIG_DIR || !path.isAbsolute(CONFIG_DIR)) throw new Error('PRM_CORE_STATE must be an absolute private directory.');"));
await patch('tools/filesystem.js', source => source
  .replace('return path.normalize(expandHome(p)).toLowerCase();', `const normalized = path.normalize(expandHome(p));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;`)
  .replace(`    // If root directory is allowed, all paths are allowed
    const allowedDirectories = await getAllowedDirs();
    if (allowedDirectories.includes('/') || allowedDirectories.length === 0) {
        return true;
    }
    let normalizedPathToCheck = normalizePath(pathToCheck);`, `    const workspace = process.env.PRM_WORKSPACE;
    let normalizedPathToCheck = normalizePath(pathToCheck);
    if (!workspace || !isWithinAllowedDir(normalizedPathToCheck, workspace)) {
        return false;
    }
    const allowedDirectories = await getAllowedDirs();`));
await patch('utils/toolHistory.js', s => s.replace("path.join(os.homedir(), '.claude-server-commander')", "process.env.PRM_CORE_STATE"));
await patch('utils/fuzzySearchLogger.js', s => s.replace("path.join(os.homedir(), '.claude-server-commander-logs')",
  "path.join(process.env.PRM_CORE_STATE, 'diagnostics')"));
await patch('tools/improved-process-tools.js', s => s.replace("const mcpRoot = path.resolve(__dirname, '..', '..');",
  "const mcpRoot = process.cwd(); // Private Remote MCP: temporary execution belongs to the selected workspace."));
await writeFile(join(destination, 'utils/capture.js'), `// Private Remote MCP adapter: telemetry is disabled and no endpoint is contacted.
export const capture = async () => {};
export const captureBase = capture;
export const capture_call_tool = capture;
export const capture_ui_event = capture;
export const captureRemote = capture;
export const captureTransport = capture;
export const buildEventProperties = async properties => properties ?? {};
export const sanitizeError = value => value;
export const isTelemetryDisabledByEnv = () => true;
export const runInUiOriginCallContext = fn => fn();
export const runWithToolCallPaths = fn => fn();
export const isInsideUiOriginCall = () => false;
export const addToolCallPaths = () => {};
`);
await writeFile(join(destination, 'utils/feature-flags.js'), `// Private Remote MCP: deterministic local flags. No cache or network refresh.
export const featureFlagManager = {
  initialize: async () => {},
  get: (_name, fallback = false) => fallback,
  getAll: () => ({}),
  refresh: async () => true,
  wasLoadedFromCache: () => true,
  waitForFreshFlags: async () => {},
  dispose: () => {}
};
`);
await writeFile(join(destination, 'utils/mcp-ui-ab-test.js'), `// Private Remote MCP: always expose the supported MCP App resources.
export const MCP_UI_EXPERIMENT_NAME = 'McpUiPreviews';
export const MCP_UI_SHOW_VARIANT = 'showMCPUi';
export const MCP_UI_HIDE_VARIANT = 'notShowMCPUi';
export const shouldShowMcpUiPreviews = async () => true;
export const resolveMcpUiPreviewDecision = async () => true;
`);
await writeFile(join(destination, 'utils/welcome-onboarding.js'), `// Onboarding is managed by the independent Gateway.
export const handleWelcomePageOnboarding = async () => {};
export const skipWelcomePageOnboarding = async () => {};
`);
await writeFile(join(destination, 'utils/dockerPrompt.js'), `// Installation guidance is owned by the independent project.
export const processDockerPrompt = async value => value;
`);
await writeFile(join(destination, 'tools/feedback.js'), `import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
// The original feedback tool is retained as a local feedback event.
export async function giveFeedbackToDesktopCommander(params = {}) {
  await appendFile(join(process.env.PRM_CORE_STATE, 'feedback.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...params }) + '\\n', { mode: 0o600 });
  return { content: [{ type: 'text', text: 'Feedback recorded in the private Agent state directory.' }] };
}
`);
await writeFile(join(destination, 'utils/ripgrep-resolver.js'), `import { isAbsolute } from 'node:path';
import { access } from 'node:fs/promises';
export async function getRipgrepPath() {
  const file = process.env.PRM_RIPGREP;
  if (!file || !isAbsolute(file)) throw new Error('Configure the absolute path of a trusted ripgrep executable on the Agent.');
  await access(file);
  return file;
}
export function clearRipgrepCache() {}
`);
await patch('tools/pdf/markdown.js', s => {
  const first = s.indexOf('async function getChromePath() {');
  const last = s.indexOf('\n/**', first);
  if (first < 0 || last < 0) throw new Error('Chrome resolver location changed.');
  return s.slice(0, first) + `async function getChromePath() {
    const executable = process.env.PRM_CHROME_PATH;
    if (!executable || !isAbsolute(executable) || !existsSync(executable)) return undefined;
    return executable;
}
` + s.slice(last);
});
await writeFile(join(destination, 'NOTICE.md'), `# Desktop Commander local core

Source package @wonderwhy-er/desktop-commander 0.3.3.
Upstream commit bce370e9395f5bc74eda34913e5ae1dee48df8f8.
MIT license and upstream copyright are preserved in LICENSE.

This directory reuses the published TypeScript output for tools and MCP App
resources. scripts/prepare-dc-core.mjs records reproducible local modifications.
The remote-device runtime, official authentication and npm installation scripts
are excluded. Telemetry, remote feature flags, browser onboarding and promotional
messages use local adapters. Configuration, history and diagnostics are stored
under PRM_CORE_STATE. Chrome and ripgrep resolve only to locally configured
executables. node:local temporary scripts run in the selected workspace.

The original tool schemas use the zod3 dependency alias. The independent
Gateway uses its own zod 4 schemas. The feedback tool records local feedback.
`);
const fileHashes = [];
async function inventory(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      await inventory(file, name + '/');
      continue;
    }
    if (['manifest.json', 'catalog.json', 'NOTICE.md'].includes(name)) continue;
    const originalFile = join(source, name === 'LICENSE' ? name : 'dist/' + name);
    const original = await readFile(originalFile);
    const current = await readFile(file);
    const upstreamSha256 = createHash('sha256').update(original).digest('hex');
    const vendoredSha256 = createHash('sha256').update(current).digest('hex');
    fileHashes.push({ path: name, upstreamSha256, vendoredSha256, modified: upstreamSha256 !== vendoredSha256 });
  }
}
await inventory(destination);
fileHashes.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(join(destination, 'manifest.json'), JSON.stringify({
  package: '@wonderwhy-er/desktop-commander',
  version: '0.3.3',
  revision: 'bce370e9395f5bc74eda34913e5ae1dee48df8f8',
  tarballSha256: '42390020cceb1cdfa537506fcd70f61eae10ab226c098403f1c5a77c350b07b3',
  generatedCatalog: 'catalog.json is generated by dc-core --catalog from live MCP SDK discovery.',
  files: fileHashes
}, null, 2) + '\n');
console.log('Prepared Desktop Commander local core 0.3.3.');
