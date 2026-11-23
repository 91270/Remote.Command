import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './agent-config.js';
import { agentLock, identity, identityFile } from './client-commands.js';
import { hash } from './protocol.js';

const actions = ['render', 'install', 'start', 'stop', 'status', 'remove'];
const help = 'Usage: remote-command service render|install|start|stop|status|remove CONFIG';
const xml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
const systemd = (value: string) => '"' + value.replace(/[\\"]/g, '\\$&').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
const powershell = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const windows = (value: string) => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"';

export function serviceDefinition(platform: string, name: string, node: string, cli: string, file: string) {
  const args = [cli, 'agent', 'run', file, '--service', '--disable-no-sleep'];
  if ([name, node, ...args].some(value => /[\u0000-\u001f\u007f]/.test(value))) throw new Error('Service paths must not contain control characters.');
  if (platform === 'linux') return `[Unit]
Description=Remote.Command Agent

[Service]
Type=exec
ExecStart=${[node, ...args].map(systemd).join(' ')}
Restart=on-failure
RestartSec=10s
TimeoutStopSec=25s
KillMode=mixed
UMask=0077

[Install]
WantedBy=default.target
`;
  if (platform === 'darwin') return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(name)}</string>
  <key>ProgramArguments</key><array>
${[node, ...args].map(value => `    <string>${xml(value)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>25</integer>
</dict></plist>
`;
  if (platform === 'win32') return `$ErrorActionPreference = 'Stop'
$name = ${powershell(name)}
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'The Agent task already exists.' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute ${powershell(node)} -Argument ${powershell(args.map(windows).join(' '))}
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
try { Start-ScheduledTask -TaskName $name } catch { Unregister-ScheduledTask -TaskName $name -Confirm:$false; throw }
`;
  throw new Error('Background services support macOS, Linux and Windows.');
}

function run(executable: string, args: string[]) {
  execFileSync(executable, args, { stdio: 'inherit', timeout: 40000, windowsHide: true });
}

export async function runService(args: string[]) {
  const [action, configFile] = args;
  if (action === '--help' || action === '-h') { console.log(help); return; }
  if (args.length !== 2 || !action || !actions.includes(action) || !configFile) throw new Error(help);
  const cfgFile = await realpath(resolve(configFile));
  const id = 'remote-command-mcp-' + hash(process.platform === 'win32' ? cfgFile.toLowerCase() : cfgFile).slice(0, 12).replace(/_/g, 'a');
  const platform = process.platform;
  const label = platform === 'darwin' ? 'io.' + id : id;
  const cli = await realpath(fileURLToPath(new URL('./remote-cli.js', import.meta.url)));
  const node = await realpath(process.execPath);
  const definition = serviceDefinition(platform, label, node, cli, cfgFile);
  if (action === 'render') { process.stdout.write(definition); return; }

  if (action === 'install') {
    if (cli.split(sep).some(part => part === '_npx')) throw new Error('Install the package to a stable local path before registering a service.');
    const cfg = await loadConfig(cfgFile);
    const paired = identity.parse(JSON.parse(await readFile(identityFile(cfg), 'utf8')));
    if (paired.origin !== cfg.origin) throw new Error('Pair the Agent with the configured Gateway first.');
    const release = await agentLock(cfg);
    await release();
  }

  if (platform === 'win32') {
    const task = '-TaskName ' + powershell(label);
    const commands: Record<string, string> = {
      install: definition,
      start: 'Start-ScheduledTask ' + task,
      stop: 'Stop-ScheduledTask ' + task,
      status: 'Get-ScheduledTask ' + task + ' | Format-List TaskName,State',
      remove: '$task = Get-ScheduledTask ' + task + '; if ($task.State -eq \'Running\') { Stop-ScheduledTask ' + task + ' }; Unregister-ScheduledTask ' + task + ' -Confirm:$false'
    };
    const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from("$ErrorActionPreference = 'Stop'\n" + commands[action], 'utf16le').toString('base64');
    run(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
    return;
  }

  const userConfig = process.env.XDG_CONFIG_HOME;
  const unit = label + '.service';
  const linuxFile = join(userConfig && isAbsolute(userConfig) ? userConfig : join(homedir(), '.config'), 'systemd', 'user', unit);
  const mac = platform === 'darwin';
  const file = mac ? join(homedir(), 'Library', 'LaunchAgents', label + '.plist') : linuxFile;
  const domain = mac ? 'gui/' + process.getuid!() : '';
  const target = domain + '/' + label;
  const ctl = (...args: string[]) => run(mac ? '/bin/launchctl' : 'systemctl', mac ? args : ['--user', ...args]);

  if (action === 'install') {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, definition, { flag: 'wx', mode: 0o600 });
    try {
      if (mac) ctl('bootstrap', domain, file);
      else { ctl('daemon-reload'); ctl('enable', '--now', unit); }
    } catch (error) {
      // Keep the registration file available for status or removal after a partial manager failure.
      throw new Error('Service registration failed. Check the manager output and remove the generated service before retrying.', { cause: error });
    }
  } else if (action === 'remove') {
    await readFile(file);
    if (mac) {
      try { execFileSync('/bin/launchctl', ['print', target], { stdio: 'ignore' }); ctl('bootout', target); }
      catch (error) { if ((error as { status?: number }).status !== 113) throw error; }
    } else ctl('disable', '--now', unit);
    await unlink(file);
    if (!mac) ctl('daemon-reload');
  } else if (mac) {
    if (action === 'status') ctl('print', target);
    if (action === 'stop') ctl('bootout', target);
    if (action === 'start') {
      try { execFileSync('/bin/launchctl', ['print', target], { stdio: 'ignore' }); }
      catch (error) {
        if ((error as { status?: number }).status !== 113) throw error;
        ctl('bootstrap', domain, file);
        return;
      }
      ctl('kickstart', target);
    }
  } else ctl(action, unit);
}
