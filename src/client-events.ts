import { appendFile, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const maxBytes = 64 * 1024;
const event = z.strictObject({
  at: z.iso.datetime(),
  event: z.enum(['starting', 'core_ready', 'core_disconnected', 'core_retry', 'gateway_online',
    'gateway_unreachable', 'pairing_revoked', 'stopped']),
  executor: z.enum(['desktop-commander', 'basic']).optional(),
  pid: z.number().int().positive().optional()
});
type Event = Omit<z.infer<typeof event>, 'at'>;

export function clientEvents(stateDir: string) {
  const file = join(stateDir, 'client-events.jsonl');
  let pending = Promise.resolve();
  return {
    record(value: Event) {
      const line = JSON.stringify(event.parse({ at: new Date().toISOString(), ...value })) + '\n';
      pending = pending.then(async () => {
        const info = await stat(file).catch(() => undefined);
        if (info && info.size + Buffer.byteLength(line) > maxBytes) await rename(file, file + '.previous');
        await appendFile(file, line, { mode: 0o600 });
      }).catch(() => {
        // Diagnostics must not interrupt the Agent's connection or execution.
      });
    },
    flush() { return pending; }
  };
}

export async function recentClientEvents(stateDir: string) {
  const events: z.infer<typeof event>[] = [];
  for (const name of ['client-events.jsonl.previous', 'client-events.jsonl']) {
    const file = await open(join(stateDir, name), 'r').catch(() => undefined);
    if (!file) continue;
    try {
      const bytes = Buffer.alloc(maxBytes);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      for (const line of bytes.subarray(0, bytesRead).toString('utf8').split('\n')) {
        if (!line) continue;
        try {
          const entry = event.safeParse(JSON.parse(line));
          if (entry.success) events.push(entry.data);
        } catch { /* ignore invalid or incomplete diagnostic entries */ }
      }
    } finally { await file.close(); }
  }
  return events.slice(-100);
}
