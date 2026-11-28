import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

export const secret = () => randomBytes(32).toString('base64url');
export const hash = (s: string) => createHash('sha256').update(s).digest('base64url');
export const match = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export const uuid = z.uuid();
export const agentClientId = 'remote-command-agent';
export const { version: projectVersion } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
export const operations = {
  disconnect: z.strictObject({}),
  dc_call: z.strictObject({ tool: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), arguments: z.record(z.string(), z.unknown()) }),
  dc_resource: z.strictObject({ uri: z.string().min(1).max(1024) })
};
export const names = Object.keys(operations) as Op[];
export type Op = keyof typeof operations;
export const capabilities = ['read', 'write', 'exec'] as const;
export type Capability = typeof capabilities[number];
export const approvalModes = ['client', 'exec-only', 'strict'] as const;
export type ApprovalMode = typeof approvalModes[number];
export function needsLocalApproval(mode: ApprovalMode, cap: Capability): boolean {
  if (mode === 'client') return false;
  if (mode === 'exec-only') return cap === 'exec';
  return cap !== 'read';
}
export function capability(op: Op, args: Record<string, unknown> = {}): Capability {
  if (op === 'dc_call') return dcCapability(String(args.tool), (args.arguments ?? {}) as Record<string, unknown>);
  return op === 'dc_resource' ? 'read' : 'exec';
}
export function dcCapability(tool: string, args: Record<string, unknown> = {}): Capability {
  if (['start_process', 'interact_with_process', 'force_terminate', 'kill_process', 'give_feedback_to_desktop_commander'].includes(tool) ||
      ['read_file', 'read_multiple_files'].includes(tool) && args.isUrl === true) return 'exec';
  if (['write_file', 'write_pdf', 'create_directory', 'move_file', 'edit_block', 'set_config_value'].includes(tool)) return 'write';
  const readTools = ['get_config', 'read_file', 'read_multiple_files', 'list_directory', 'start_search', 'get_more_search_results',
    'stop_search', 'list_searches', 'get_file_info', 'read_process_output', 'list_sessions', 'list_processes',
    'get_usage_stats', 'get_recent_tool_calls'];
  if (!readTools.includes(tool)) throw new Error('Unknown Desktop Commander tool.');
  return 'read';
}
export const coreResult = CallToolResultSchema.refine(value => JSON.stringify(value).length <= 4 * 1024 * 1024,
  'Result exceeds 4 MiB. Read a smaller range or fewer pages.');
export const catalog = z.object({
  tools: z.array(z.object({ name: z.string().max(80), description: z.string().max(24000).optional(),
    inputSchema: z.record(z.string(), z.unknown()), annotations: z.record(z.string(), z.unknown()).optional(),
    _meta: z.record(z.string(), z.unknown()).optional() }).passthrough()).max(40),
  resources: z.array(z.object({ uri: z.string().max(1024), name: z.string().max(128), mimeType: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional() }).passthrough()).max(16)
});
export type Catalog = z.infer<typeof catalog>;
export const live = ['dispatched', 'awaiting_approval', 'running'] as const;
export const terminal = ['succeeded', 'failed', 'denied', 'cancelled', 'timed_out', 'interrupted'] as const;
export const update = z.strictObject({
  id: uuid, seq: z.number().int().positive(), status: z.enum(['awaiting_approval', 'running', ...terminal]),
  output: z.string().max(40000).optional(), result: coreResult.optional(), boot: uuid.optional()
});
export type Update = z.infer<typeof update>;
export const work = z.strictObject({ id: uuid, op: z.enum(names as [Op, ...Op[]]), args: z.record(z.string(), z.unknown()) });
export type Work = z.infer<typeof work>;
export const maxBody = 40 * 1024 * 1024;
export const maxActive = 4;
export const maxWaiting = 64;
export const maxUserActive = 8;
export const maxUserWaiting = 128;
export const approvalMs = 300_000;
export const offlineMs = 15_000;
export const defaultLongPollMs = 25_000;
export const maxLongPollMs = 30_000;
export const defaultSyncWaitMs = 15_000;
export const maxSyncWaitMs = 55_000;
export const defaultTaskLeaseMs = 6 * 60_000;
export const maxTaskLifetimeMs = 60 * 60_000;
export const sync = z.strictObject({
  boot: uuid,
  platform: z.enum(['darwin', 'win32', 'linux']),
  updates: z.array(update).max(8),
  catalog: catalog.optional(),
  ready: z.boolean().optional(),
  waitMs: z.number().int().min(0).max(maxLongPollMs).optional()
});
export const syncReply = z.strictObject({
  jobs: z.array(work).max(8),
  cancel: z.array(uuid).max(8),
  ack: z.array(uuid).max(8),
  approvalMode: z.enum(approvalModes).optional(),
  capabilities: z.array(z.enum(capabilities)).min(1).max(3).optional(),
  deviceName: z.string().max(128).optional(),
  userEmail: z.string().max(256).optional()
});
export const clip = (s: string) => s.length > 39000 ? s.slice(0, 39000) + '\n[output truncated]' : s;
export const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export function endpoint(s: string, allowLoopback = false): URL {
  const url = new URL(s);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    throw new Error('Use a bare HTTPS origin; plaintext is only available for explicit loopback tests.');
  }
  return url;
}
