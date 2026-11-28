import { access, readFile, lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { constants } from 'node:fs';
import { resolve, join, isAbsolute, parse, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { capabilities, endpoint } from './protocol.js';
import { inside } from './workspace.js';

const config = z.strictObject({
  gateway: z.string(), workspace: z.string().refine(isAbsolute), stateDir: z.string().refine(isAbsolute),
  allowInsecureLoopback: z.boolean().default(false), capabilities: z.array(z.enum(capabilities)).min(1).max(3).optional(),
  noSleep: z.boolean().default(true),
  logToFile: z.boolean().default(false),
  chromePath: z.string().refine(isAbsolute).optional(),
  ripgrep: z.string().refine(isAbsolute).optional()
});
async function findExecutable(paths: (string | undefined)[], workspace: string) {
  for (const candidate of paths) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      const location = await realpath(candidate);
      if (inside(workspace, location) || !(await lstat(location)).isFile()) continue;
      await access(location, constants.X_OK);
      return location;
    } catch { /* candidate missing or not runnable */ }
  }
}

async function bundledRipgrep() {
  try {
    const packageName = '@vscode/ripgrep';
    const { rgPath } = await import(packageName);
    return typeof rgPath === 'string' ? rgPath : undefined;
  } catch { return undefined; }
}

function pathExecutables(names: string[]) {
  const directories = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute);
  return directories.flatMap(directory => names.map(name => join(directory, name)));
}

function chromeCandidates() {
  if (process.platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ];
  if (process.platform === 'win32') {
    return [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter((path): path is string => !!path).map(path => join(path, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return pathExecutables(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
}

export async function loadConfig(filename: string, { diagnostics = false } = {}) {
  const configFile = await realpath(resolve(filename));
  const contents = JSON.parse((await readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
  return resolveAgentConfig(contents, configFile, diagnostics);
}

export async function resolveAgentConfig(contents: unknown, configFile: string, diagnostics = false) {
  const cfg = config.parse(contents);
  const workspace = await realpath(cfg.workspace).catch(error => {
    if (diagnostics) return resolve(cfg.workspace);
    throw error;
  });
  const home = await realpath(homedir());
  if (workspace === parse(workspace).root || inside(workspace, home) || !diagnostics && !(await lstat(workspace)).isDirectory())
    throw new Error('Choose a specific workspace directory separate from the home or filesystem root.');
  const install = fileURLToPath(new URL('..', import.meta.url));
  if (inside(workspace, configFile) || inside(workspace, install) || inside(workspace, resolve(cfg.stateDir)) || inside(resolve(cfg.stateDir), workspace))
    throw new Error('Workspace, Agent configuration, installation and private state must be separate.');
  await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(cfg.stateDir);
  if (inside(workspace, stateDir) || inside(stateDir, workspace) || inside(stateDir, home) || inside(stateDir, install))
    throw new Error('Choose a private Agent state directory.');
  const stateStat = await lstat(stateDir);
  if (process.platform !== 'win32' && (stateStat.mode & 0o077) !== 0)
    throw new Error('Agent state directory permissions must be 0700.');
  const approvals = join(stateDir, 'approvals');
  await mkdir(approvals, { recursive: true, mode: 0o700 });
  const approvalStat = await lstat(approvals);
  if (!approvalStat.isDirectory() || approvalStat.isSymbolicLink() || (process.platform !== 'win32' && (approvalStat.mode & 0o077) !== 0))
    throw new Error('Approval directory must be private and cannot be a link.');
  const pendingResults = join(stateDir, 'pending-results');
  await mkdir(pendingResults, { recursive: true, mode: 0o700 });
  const pendingStat = await lstat(pendingResults);
  if (!pendingStat.isDirectory() || pendingStat.isSymbolicLink() || (process.platform !== 'win32' && (pendingStat.mode & 0o077) !== 0))
    throw new Error('Pending results directory must be private and cannot be a link.');
  const rgExecutable = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const ripgrep = cfg.ripgrep
    ? (diagnostics ? cfg.ripgrep : await realpath(cfg.ripgrep))
    : await findExecutable([await bundledRipgrep(), ...pathExecutables([rgExecutable])], workspace);
  if (!diagnostics && ripgrep && (inside(workspace, ripgrep) || !(await lstat(ripgrep)).isFile()))
    throw new Error('ripgrep must point to a trusted executable outside the workspace.');
  const chromePath = cfg.chromePath ?? await findExecutable(chromeCandidates(), workspace);
  return { ...cfg, origin: endpoint(cfg.gateway, cfg.allowInsecureLoopback).origin, workspace, stateDir, approvals, pendingResults, ripgrep, chromePath };
}
export type AgentConfig = Awaited<ReturnType<typeof loadConfig>>;
