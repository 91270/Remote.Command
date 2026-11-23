import { link, mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';

const [destination, ...extra] = process.argv.slice(2);
if (!destination || extra.length) throw new Error('Usage: npm run backup -- /private/path/backup.sqlite');
const output = resolve(destination);
const stage = await mkdtemp(join(dirname(output), '.rcm-export-'));
const partial = join(stage, 'backup.sqlite');

try {
  const child = spawn('docker', ['compose', 'exec', '-T', 'gateway', 'node', 'dist/admin.js', 'backup'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const completed = once(child, 'close');
  try {
    const [[code, signal]] = await Promise.all([completed, pipeline(child.stdout, createWriteStream(partial, { flags: 'wx', mode: 0o600 }))]);
    if (code !== 0) throw new Error('Docker Gateway backup exited with ' + (signal ?? code));
    await link(partial, output);
    console.log('Backup saved:', output);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await completed.catch(() => {});
  }
} finally { await rm(stage, { recursive: true, force: true }); }
