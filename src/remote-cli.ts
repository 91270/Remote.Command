#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runAgentCli } from './agent.js';
import { runService } from './agent-service.js';
import { resolveAgentConfig } from './agent-config.js';
import { endpoint, errorText } from './protocol.js';
import { deviceReport } from './client-commands.js';
import { inside } from './workspace.js';

const help = `Usage: remote-command remote [options]
       remote-command agent approvals|decide CONFIG [TASK approve|deny]
       remote-command service render|install|start|stop|status|remove CONFIG

  --logout              Revoke this device and remove saved credentials.
  --report              Save a local diagnostics ZIP and exit.
  --no-persist-session  Pair for this run without saving credentials.
  --disable-no-sleep    Disable macOS keep-awake mode.
  -v, --verbose         Show expanded tool arguments and output previews.
  --log-file            Write plain-text rotating logs under <stateDir>/logs.
  --debug               Print executor recovery details.
  --no-browser          Print the pairing URL without opening a browser.
  --gateway URL         Preset the self-hosted Gateway HTTPS URL on first run.
  --workspace PATH      Preset the allowed workspace directory on first run.
  -y, --yes             Accept defaults for unspecified first-run prompts.
  --config PATH         Select the Agent JSON configuration file.
  -h, --help            Show this help.

First run uses a safe default workspace (~/RemoteCommand-Workspace if needed) and opens browser pairing directly when --gateway or RCM_GATEWAY is set. Device permissions are configured on the Web Dashboard during pairing.`;

const options = {
  help: { type: 'boolean', short: 'h' },
  logout: { type: 'boolean' },
  report: { type: 'boolean' },
  'no-persist-session': { type: 'boolean' },
  'disable-no-sleep': { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  'log-file': { type: 'boolean' },
  debug: { type: 'boolean' },
  'no-browser': { type: 'boolean' },
  gateway: { type: 'string' },
  workspace: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  config: { type: 'string' }
} as const;

async function exists(filename: string) {
  try { await access(filename); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

type PresetConfig = { gateway?: string; workspace?: string; yes?: boolean };

async function pickDefaultWorkspace(cwd: string, configFile: string, stateDir: string): Promise<string> {
  const home = await realpath(homedir());
  const install = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  try {
    const resolvedCwd = await realpath(cwd);
    const isRoot = resolvedCwd === parse(resolvedCwd).root;
    const touchesHome = inside(resolvedCwd, home);
    const touchesConfig = inside(resolvedCwd, configFile);
    const touchesInstall = inside(resolvedCwd, install) || inside(install, resolvedCwd);
    const touchesState = inside(resolvedCwd, stateDir) || inside(stateDir, resolvedCwd);
    if (!isRoot && !touchesHome && !touchesConfig && !touchesInstall && !touchesState) {
      return resolvedCwd;
    }
  } catch {
    // Fall back to dedicated workspace directory when cwd cannot be resolved.
  }
  const fallback = join(home, 'RemoteCommand-Workspace');
  await mkdir(fallback, { recursive: true });
  return await realpath(fallback);
}

export async function configureAgent(file: string, defaultConfig: boolean, preset: PresetConfig = {}) {
  const gatewayInput = preset.gateway?.trim() || process.env.RCM_GATEWAY?.trim() || undefined;
  const needsPrompt = !gatewayInput;
  if (needsPrompt && !process.stdin.isTTY) {
    throw new Error('First run needs a Gateway URL. Pass --gateway <url> (or set RCM_GATEWAY) or supply an existing Agent JSON file with --config.');
  }

  const rl = needsPrompt ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const abort = new AbortController();
  rl?.on('SIGINT', () => abort.abort());
  const answer = async (prompt: string) => (await rl!.question(prompt, { signal: abort.signal })).trim();
  try {
    const gateway = endpoint(gatewayInput ?? await answer('Self-hosted Gateway HTTPS URL: ')).origin;
    const parent = dirname(file);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await realpath(parent);
    const canonicalFile = join(directory, basename(file));
    const stateDir = join(directory, defaultConfig ? 'device' : basename(file) + '.state');
    const workspace = preset.workspace
      ? await realpath(resolve(preset.workspace))
      : await pickDefaultWorkspace(process.cwd(), canonicalFile, stateDir);
    const config = { gateway, workspace, stateDir };
    await resolveAgentConfig(config, canonicalFile);
    await writeFile(canonicalFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`Saved configuration: ${canonicalFile} (workspace: ${workspace})`);
  } finally { rl?.close(); }
}

async function main() {
  const [subcommand, ...args] = process.argv.slice(2);
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(help);
    return;
  }
  if (subcommand === 'agent') { await runAgentCli(args); return; }
  if (subcommand === 'service') { await runService(args); return; }
  if (subcommand !== 'remote') throw new Error('Unknown command. Run remote-command remote --help.');
  const { values } = parseArgs({ args, options });
  if (values.help) { console.log(help); return; }

  const maintenance = values.logout ? 'logout' : values.report ? 'report' : 'connect';
  const explicit = values.config ?? process.env.RCM_AGENT_CONFIG;
  const defaultFile = join(homedir(), '.remote-command', 'agent.json');
  const file = explicit ? resolve(explicit) : defaultFile;
  if (!await exists(file)) {
    if (explicit && maintenance !== 'connect') throw new Error('Agent configuration not found: ' + file);
    if (maintenance === 'logout') { console.log('This Agent has no saved identity.'); return; }
    if (maintenance === 'report') { await deviceReport(); return; }
    await configureAgent(file, file === defaultFile, {
      gateway: values.gateway,
      workspace: values.workspace,
      yes: values.yes
    });
  }
  const flags = ['no-persist-session', 'disable-no-sleep', 'verbose', 'log-file', 'debug', 'no-browser'] as const;
  await runAgentCli([maintenance, file, ...flags.filter(flag => values[flag]).map(flag => '--' + flag)]);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try { await main(); }
  catch (error) { console.error(errorText(error)); process.exitCode = 1; }
}
