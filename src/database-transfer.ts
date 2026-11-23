import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, link, lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { Store } from './store.js';

async function exists(file: string) {
  return lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

function check(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema=OFF');
    const check = db.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || Object.values(check[0]!)[0] !== 'ok') throw new Error('SQLite integrity check failed.');
    for (const table of ['devices', 'tasks', 'audit', 'auth', 'invites', 'retired_boots']) {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))
        throw new Error('Expected a Remote.Command database.');
    }
  } finally { db.close(); }
}

export async function exportDatabase(file: string) {
  const sourceFile = await realpath(file);
  if (!(await stat(sourceFile)).isFile()) throw new Error('Gateway database must be a regular file.');
  const temp = await mkdtemp(join(dirname(sourceFile), '.rcm-backup-'));
  const snapshot = join(temp, 'snapshot.sqlite');
  try {
    const source = new DatabaseSync(sourceFile, { readOnly: true });
    try {
      source.exec('PRAGMA busy_timeout=5000');
      await backup(source, snapshot);
    } finally { source.close(); }
    check(snapshot);
    await pipeline(createReadStream(snapshot), process.stdout);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function importDatabase(target: string, verifyOnly: boolean) {
  if (process.stdin.isTTY) throw new Error('Redirect a backup file to stdin.');
  const filename = resolve(target);
  if (!verifyOnly) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (await exists(filename + suffix)) throw new Error('Restore requires a new database path. The existing database was kept.');
    }
  }
  const temp = await mkdtemp(join(dirname(filename), '.rcm-restore-'));
  const snapshot = join(temp, 'snapshot.sqlite');
  try {
    await pipeline(process.stdin, createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }));
    check(snapshot);
    if (verifyOnly) return;

    const store = new Store(snapshot);
    try {
      store.db.exec('PRAGMA trusted_schema=OFF');
      store.tx(() => {
        store.db.exec(`DELETE FROM auth; DELETE FROM invites;
          UPDATE devices SET revoked=1,seen=0;
          DELETE FROM retired_boots;`);
        const jobs = store.db.prepare("SELECT id FROM tasks WHERE status IN ('queued','dispatched','awaiting_approval','running')").all();
        for (const job of jobs) store.finish(String(job.id), 'interrupted', 'Database restored from backup. Check the device before resubmitting.');
        store.audit('database_restored', { interruptedTasks: jobs.length });
      });
      store.db.exec('PRAGMA journal_mode=DELETE');
    } finally { store.db.close(); }
    check(snapshot);
    await chmod(snapshot, 0o600);
    await link(snapshot, filename);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
