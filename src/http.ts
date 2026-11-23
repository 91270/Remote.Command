import type { IncomingMessage, ServerResponse } from 'node:http';
import { maxBody } from './protocol.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function json(res: ServerResponse, status: number, result: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(result));
}
export async function body(req: IncomingMessage, type: string, limit = maxBody) {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== type) throw new HttpError(415, 'Unsupported content type.');
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'Request too large.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Avoid an async iterator destroying the socket on its early return.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) { req.resume(); throw new HttpError(413, 'Request too large.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function readJson(req: IncomingMessage, limit = maxBody): Promise<unknown> {
  const data = await body(req, 'application/json', limit);
  try { return JSON.parse(data); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}
export const bearer = (req: IncomingMessage) => /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization ?? '')?.[1];
