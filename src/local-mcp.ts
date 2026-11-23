import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, readdir, realpath, open, unlink, mkdir } from 'node:fs/promises';
import { relative, dirname, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { clip, errorText, names, operations } from './protocol.js';
import { workspacePath } from './workspace.js';
import { textCore, editCore, renameCore, searchCore } from './vendor.js';

const root = await realpath(process.cwd());
const server = new Server({ name: 'private-remote-local-core', version: '0.1.0' }, { capabilities: { tools: {} } });
const reply = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text: clip(text) }], ...(isError ? { isError } : {}) });
const text = new (await textCore()).TextFileHandler();
const { exactReplacement } = await editCore();
const { renameWithRetry } = await renameCore();
const { searchManager } = await searchCore();
const maxFile = 1024 * 1024;

async function utf8(input: string, missing = false) {
  const target = await workspacePath(root, input, { missing });
  if (!target.info) return { ...target, content: '' };
  if (!target.info.isFile() || target.info.size > maxFile) throw new Error('Expected a regular text file up to 1 MiB.');
  const bytes = await readFile(target.path);
  if (bytes.length > maxFile || bytes.includes(0)) throw new Error('Expected a small UTF-8 text file.');
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return { ...target, content };
}
async function replaceFile(target: Awaited<ReturnType<typeof utf8>>, input: string, content: string, signal: AbortSignal) {
  if (Buffer.byteLength(content) > maxFile || content.includes('\0')) throw new Error('Expected UTF-8 text up to 1 MiB.');
  const temp = join(dirname(target.path), '.prm-' + randomUUID() + '.tmp');
  const handle = await open(temp, 'wx', target.info ? target.info.mode & 0o777 : 0o600);
  try {
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    const current = await utf8(input, true);
    if (!!current.info !== !!target.info || current.info?.ino !== target.info?.ino || current.info?.mtimeMs !== target.info?.mtimeMs ||
        current.content !== target.content) throw new Error('The file changed during the operation.');
    signal.throwIfAborted();
    await renameWithRetry(temp, target.path);
  } finally { await unlink(temp).catch(() => {}); }
}
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: names.filter(n => n !== 'start_command').map(name => ({ name, inputSchema: z.toJSONSchema(operations[name], { target: 'draft-07' }) as { type: 'object' } }))
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
  try {
    signal.throwIfAborted();
    const a = params.arguments ?? {};
    switch (params.name) {
      case 'read_file': {
        const arg = operations.read_file.parse(a);
        const target = await utf8(arg.path);
        const r = await text.read(target.path, { offset: arg.offset ?? 0, length: arg.length ?? 200, signal });
        return reply(r.content);
      }
      case 'list_directory': {
        const target = await workspacePath(root, operations.list_directory.parse(a).path, { root: true });
        if (!target.info?.isDirectory()) throw new Error('Expected a directory.');
        const entries = (await readdir(target.path, { withFileTypes: true })).filter(e => e.isDirectory() || e.isFile());
        return reply(JSON.stringify({ entries: entries.slice(0, 160).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })), truncated: entries.length > 160 }));
      }
      case 'get_file_info': {
        const arg = operations.get_file_info.parse(a);
        const { info } = await workspacePath(root, arg.path, { root: true });
        return reply(JSON.stringify({ path: arg.path, type: info!.isDirectory() ? 'directory' : 'file', bytes: info!.size, modified: info!.mtime.toISOString() }));
      }
      case 'write_file': {
        const arg = operations.write_file.parse(a);
        await replaceFile(await utf8(arg.path, true), arg.path, arg.content, signal);
        return reply('File saved.');
      }
      case 'edit_block': {
        const arg = operations.edit_block.parse(a);
        const original = await utf8(arg.file_path);
        await replaceFile(original, arg.file_path, exactReplacement(original.content, { search: arg.old_string, replace: arg.new_string }), signal);
        return reply('Replaced one matching text block.');
      }
      case 'create_directory': {
        const arg = operations.create_directory.parse(a);
        const item = await workspacePath(root, arg.path, { missing: true });
        if (item.info) throw new Error('Destination exists.');
        signal.throwIfAborted();
        await mkdir(item.path);
        return reply('Directory created.');
      }
      case 'move_file': {
        const arg = operations.move_file.parse(a);
        const source = await workspacePath(root, arg.source);
        const destination = await workspacePath(root, arg.destination, { missing: true });
        if (destination.info) throw new Error('Destination exists.');
        signal.throwIfAborted();
        await renameWithRetry(source.path, destination.path);
        return reply('Entry moved.');
      }
      case 'search': {
        const arg = operations.search.parse(a);
        const target = await workspacePath(root, arg.path, { root: true });
        if (!target.info?.isDirectory()) throw new Error('Search path must be a directory.');
        const { sessionId } = await searchManager.startSearch({ rootPath: target.path, pattern: arg.pattern, searchType: arg.searchType,
          maxResults: 100, timeout: 8000, literalSearch: true, includeHidden: false });
        const stop = () => searchManager.terminateSearch(sessionId);
        signal.addEventListener('abort', stop, { once: true });
        try {
          if (signal.aborted) stop();
          await searchManager.waitForCompletion(sessionId);
          signal.throwIfAborted();
          const report = searchManager.readSearchResults(sessionId, 0, 100);
          if (report.outcome === 'failed') throw new Error('Search failed: ' + errorText(report.failure));
          const results = [];
          for (const hit of report.results) {
            const rel = relative(root, hit.file).split(sep).join('/');
            try { await workspacePath(root, rel); results.push({ ...hit, file: rel }); } catch { /* do not return linked entries */ }
          }
          return reply(JSON.stringify({ outcome: report.outcome, results }));
        } finally { signal.removeEventListener('abort', stop); searchManager.forget(sessionId); }
      }
      default: return reply('Unknown local operation.', true);
    }
  } catch (e) { return reply(errorText(e), true); }
});
await server.connect(new StdioServerTransport());
