import { spawn } from 'node:child_process';
import { programEnv } from './workspace.js';
import { terminateCore } from './vendor.js';
import { clip, errorText, type Update } from './protocol.js';

type Outcome = { status: Update['status']; output: string };
export async function runCommand(executable: string, args: string[], cwd: string, seconds: number, signal: AbortSignal,
  progress: (output: string) => void): Promise<Outcome> {
  const { terminateProcessTree } = await terminateCore();
  signal.throwIfAborted();
  const posix = process.platform !== 'win32';
  const child = spawn(executable, args, { cwd, env: programEnv(), shell: false, detached: posix,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', extra = false;
  const record = (chunk: string) => {
    const remaining = 36000 - output.length;
    if (remaining > 0) output += chunk.slice(0, remaining);
    extra ||= chunk.length > remaining;
    progress(text());
  };
  const text = () => output + (extra ? '\n[command output truncated]\n' : '');
  child.stdout.setEncoding('utf8').on('data', record);
  child.stderr.setEncoding('utf8').on('data', record);
  let wanted: 'cancelled' | 'timed_out' | undefined;
  let stopping: Promise<boolean> | undefined;
  let hard: NodeJS.Timeout | undefined;
  let failToObserveExit: () => void;
  const stop = (reason: typeof wanted) => {
    if (wanted) return;
    wanted = reason;
    hard = setTimeout(failToObserveExit, 10000);
    stopping = (async () => {
      try {
        if (posix && child.pid !== undefined) {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
          return true;
        }
        return await terminateProcessTree(child);
      } catch { return false; }
    })();
  };
  const cancel = () => stop('cancelled');
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stop('timed_out'), seconds * 1000);
  const status = await new Promise<{ code?: number | null; signal?: string | null; error?: string }>(resolve => {
    child.once('error', e => resolve({ error: errorText(e) }));
    // Older Windows process trees can outlive the root; close waits for pipes.
    child.once('close', (code, signal) => resolve({ code, signal }));
    failToObserveExit = () => {
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      resolve({ error: 'Could not observe process exit; check the device.' });
    };
    if (signal.aborted) cancel();
  });
  clearTimeout(timer);
  if (hard) clearTimeout(hard);
  signal.removeEventListener('abort', cancel);
  const stopped = stopping ? await stopping : true;
  const final = status.error ?? (status.signal ? `Signal: ${status.signal}` : `Exit code: ${status.code}`);
  return { status: !stopped || status.error ? 'failed' : wanted ?? (status.code === 0 ? 'succeeded' : 'failed'),
    output: clip(text() + '\n' + final + (stopped ? '' : '\nProcess tree termination could not be verified.')) };
}
