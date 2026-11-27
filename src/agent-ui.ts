import { RotatingLogger } from './logger.js';

const ansiPattern = /\x1b\[[0-9;]*m/g;
const sensitiveKeyPattern = /^(token|access_?token|refresh_?token|password|passwd|secret|api_?key|authorization|cookie|credential|private_?key)$/i;

const bannerLines = [
  ' ____  _____ __  __  ___ _____ _____    ____ ___  __  __ __  __    _    _   _ ____  ',
  '|  _ \\| ____|  \\/  |/ _ \\_   _| ____|  / ___/ _ \\|  \\/  |  \\/  |  / \\  | \\ | |  _ \\ ',
  '| |_) |  _| | |\\/| | | | || | |  _|   | |  | | | | |\\/| | |\\/| | / _ \\ |  \\| | | | |',
  '|  _ <| |___| |  | | |_| || | | |___  | |__| |_| | |  | | |  | |/ ___ \\| |\\  | |_| |',
  '|_| \\_\\_____|_|  |_|\\___/ |_| |_____|  \\____\\___/|_|  |_|_|  |_/_/   \\_\\_| \\_|____/ '
];

/** Format a local 24-hour HH:MM:SS timestamp. */
export function formatTime(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Strip ANSI SGR escape sequences from a string. */
export function stripAnsi(text: string): string {
  return text.replace(ansiPattern, '');
}

/** Format a millisecond duration into ms / s / m s. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return `${Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/** Recursively clone objects/arrays up to depth 6, redacting sensitive keys. */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[Object]';
  if (Array.isArray(value)) return value.map(item => redactSensitive(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = sensitiveKeyPattern.test(key) ? '[REDACTED]' : redactSensitive(val, depth + 1);
  }
  return out;
}

/** Redact sensitive fields and serialize tool arguments with length caps. */
export function redactAndFormatArgs(args: unknown, verbose: boolean): string {
  const limit = verbose ? 4000 : 300;
  let serialized: string;
  try {
    serialized = JSON.stringify(redactSensitive(args));
  } catch {
    serialized = String(args);
  }
  if (serialized === undefined) serialized = '{}';
  return serialized.length > limit ? serialized.slice(0, limit) + '…' : serialized;
}

/** Format tool execution output into a bounded single- or multi-line preview. */
export function formatToolOutputPreview(text: string | undefined, verbose: boolean): string {
  if (!text || !text.trim()) return '(empty output)';
  const normalized = text.replace(/\r\n/g, '\n');
  if (verbose) {
    const limit = 8000;
    if (normalized.length <= limit) return normalized;
    return `${normalized.slice(0, limit)}… (+${normalized.length - limit} chars)`;
  }
  const maxLines = 6;
  const maxChars = 400;
  const lines = normalized.split('\n');
  const slicedLines = lines.slice(0, maxLines);
  let preview = slicedLines.join('\n');
  let truncated = lines.length > maxLines;
  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars);
    truncated = true;
  }
  if (!truncated) return preview;
  const remaining = Math.max(0, normalized.length - preview.length);
  return `${preview}… (+${remaining} chars, ${lines.length} lines)`;
}

export type AgentUiOptions = {
  verbose?: boolean;
  debug?: boolean;
  serviceMode?: boolean;
  color?: boolean;
  logDir?: string;
  writeOut?: (line: string) => void;
  writeErr?: (line: string) => void;
  now?: () => Date;
};

export type ReadyBannerInfo = {
  userEmail?: string;
  deviceId: string;
  deviceName: string;
  gateway: string;
  workspace: string;
  capabilities: readonly string[];
  approvalMode: string;
  version: string;
  logDir?: string;
  coreToolsCount?: number;
};

/** Create the Agent terminal UI formatter and optional rotating file logger. */
export function createAgentUi(options: AgentUiOptions = {}) {
  const verbose = Boolean(options.verbose);
  const debugEnabled = Boolean(options.debug);
  const serviceMode = Boolean(options.serviceMode);
  const color = !serviceMode && (options.color ?? Boolean(process.stdout.isTTY && !process.env.NO_COLOR));
  const writeOut = options.writeOut ?? (line => console.log(line));
  const writeErr = options.writeErr ?? (line => console.error(line));
  const now = options.now ?? (() => new Date());

  let fileLogger: RotatingLogger | undefined;
  let loggerInitFailed = false;
  if (options.logDir) {
    try {
      fileLogger = new RotatingLogger({ dir: options.logDir, maxBytes: 10 * 1024 * 1024, maxFiles: 5 });
    } catch {
      loggerInitFailed = true;
    }
  }

  const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const dim = (text: string) => paint('90', text);
  const cyan = (text: string) => paint('36', text);
  const green = (text: string) => paint('32', text);
  const yellow = (text: string) => paint('33', text);
  const red = (text: string) => paint('31', text);
  const bold = (text: string) => paint('1', text);

  let lastUnreachableNoticeAt = 0;

  function emit(level: 'INFO' | 'WARN' | 'ERROR', message: string) {
    const stamp = `[${formatTime(now())}]`;
    const prefix = dim(stamp);
    const lines = message.split('\n');
    const sink = level === 'ERROR' ? writeErr : writeOut;
    for (const line of lines) {
      sink(line ? `${prefix} ${line}` : prefix);
    }
    if (fileLogger) {
      try {
        fileLogger.write(level, stripAnsi(message), false);
      } catch {
        // Rotating file logging must never disrupt Agent operation.
      }
    }
  }

  function emitSection(title: string, bodyRows: string[], footer: string) {
    emit('INFO', cyan(`┌─ ${title}`));
    for (const row of bodyRows) emit('INFO', `${cyan('│')} ${row}`);
    emit('INFO', `${cyan('└─')} ${footer}`);
  }

  if (loggerInitFailed && options.logDir) {
    emit('WARN', `⚠️ Could not initialize rotating log directory at ${options.logDir}; continuing with console output only.`);
  }

  return {
    banner() {
      if (serviceMode) {
        emit('INFO', '🌐 Remote.Command Agent starting...');
        return;
      }
      for (const line of bannerLines) emit('INFO', cyan(line));
      emit('INFO', '');
      emit('INFO', bold('🌐 Remote Connection'));
    },
    info(message: string) {
      emit('INFO', message);
    },
    substep(message: string) {
      emit('INFO', ` - ${message}`);
    },
    success(message: string) {
      emit('INFO', green(message));
    },
    warn(message: string) {
      emit('WARN', yellow(message));
    },
    error(message: string) {
      emit('ERROR', red(message));
    },
    debug(message: string) {
      if (!debugEnabled && !verbose) return;
      emit('INFO', dim(`[DEBUG] ${message}`));
    },
    ready(info: ReadyBannerInfo) {
      emit('INFO', green('✅ Device ready:'));
      const fields: [string, string][] = [];
      if (info.userEmail) fields.push(['User', info.userEmail]);
      fields.push(
        ['Device ID', info.deviceId],
        ['Device Name', info.deviceName],
        ['Gateway', info.gateway],
        ['Workspace', info.workspace],
        ['Capabilities', info.capabilities.join(', ')],
        ['Approval', info.approvalMode],
        ['Version', info.version]
      );
      if (info.logDir) fields.push(['Log Dir', info.logDir]);
      for (const [label, value] of fields) {
        const padded = `${label}:`.padEnd(14, ' ');
        emit('INFO', `   - ${dim(padded)}${value}`);
      }
      if (serviceMode) return;
      emit('INFO', '');
      emit('INFO', green('✅ Remote.Command Agent is connected'));
      emit('INFO', `   Device: ${bold(info.deviceName)}`);
      emit('INFO', `   Status: ${green('Online')}`);
      emit('INFO', '');
      emitSection(
        'Next',
        [
          'Return to ChatGPT and continue your conversation.',
          'Keep this Terminal running. You can minimize it.'
        ],
        'Press Ctrl+C to disconnect.'
      );
      emit('INFO', '');
      emitSection(
        'Commands',
        [
          'Help:    remote-command remote --help',
          'Report:  remote-command remote --report',
          'Log out: remote-command remote --logout'
        ],
        'Run these in a new Terminal, or after disconnecting.'
      );
    },
    toolReceived(jobId: string, toolName: string, args: unknown) {
      emit('INFO', `🔧 Received tool call ${dim(jobId)}: ${bold(toolName)} ${redactAndFormatArgs(args, verbose)}`);
    },
    toolAwaitingApproval(jobId: string, toolName: string) {
      emit('WARN', yellow(`🛡️ Awaiting local approval for ${toolName} (${jobId})`));
    },
    toolFinished(jobId: string, toolName: string, status: string, durationMs: number, output?: string) {
      const duration = formatDuration(durationMs);
      const preview = formatToolOutputPreview(output, verbose);
      const multiline = preview.includes('\n');
      if (status === 'succeeded') {
        if (multiline) {
          emit('INFO', `${green(`✅ Tool call ${toolName} completed`)} ${dim(`(${duration}, ${jobId})`)}\n${preview}`);
        } else {
          emit('INFO', `${green(`✅ Tool call ${toolName} completed`)} ${dim(`(${duration})`)}: ${preview}`);
        }
        return;
      }
      if (status === 'failed') {
        emit('ERROR', `${red(`❌ Tool call ${toolName} failed`)} ${dim(`(${duration})`)}: ${preview}`);
        return;
      }
      emit('WARN', `${yellow(`⛔ Tool call ${toolName} ${status}`)} ${dim(`(${duration})`)}: ${preview}`);
    },
    approvalModeChanged(mode: string) {
      emit('INFO', `🛡️ Approval mode synced: ${bold(mode)}`);
    },
    approvalPromptHeader(summary: string) {
      emit('WARN', '');
      emit('WARN', yellow(`🛡️ [Local Approval] Requested: ${summary}`));
    },
    approvalDecision(approved: boolean) {
      if (approved) emit('INFO', green('✅ [Local Approval] Approved and submitted for execution.'));
      else emit('WARN', yellow('⛔ [Local Approval] Denied.'));
    },
    gatewayUnreachable(reason: string, retryMs: number, attempt: number) {
      const currentMs = now().getTime();
      if (attempt <= 1) {
        lastUnreachableNoticeAt = currentMs;
        emit('WARN', yellow(`⚠️ Gateway unreachable (${reason}); retrying in ${formatDuration(retryMs)}...`));
        return;
      }
      if (debugEnabled || verbose || currentMs - lastUnreachableNoticeAt >= 30_000) {
        lastUnreachableNoticeAt = currentMs;
        emit('WARN', yellow(`⚠️ Still unable to reach Gateway (attempt #${attempt}, retrying in ${formatDuration(retryMs)})...`));
      }
    },
    gatewayReconnected(offlineMs: number) {
      lastUnreachableNoticeAt = 0;
      emit('INFO', green(`🔄 Reconnected to Gateway (offline for ${formatDuration(offlineMs)}). Device is back online.`));
    },
    coreDisconnected() {
      emit('WARN', yellow('⚠️ Local Desktop Commander core disconnected; restarting...'));
    },
    coreRecovered(toolsCount?: number) {
      const suffix = toolsCount !== undefined ? ` (${toolsCount} tools ready)` : '';
      emit('INFO', green(`✅ Local Desktop Commander core recovered${suffix}.`));
    },
    disconnecting(reason?: string) {
      emit('INFO', `👋 Disconnecting Agent${reason ? ` (${reason})` : ''}...`);
    },
    disconnected() {
      emit('INFO', green('✅ Agent disconnected.'));
    }
  };
}
