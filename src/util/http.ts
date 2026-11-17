// util/http.ts — response + auth helpers shared by every surface (REST, GraphQL, MCP, git glue).

import type { IncomingMessage, ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

/** One request-id source: counter + fixed prefix, non-empty, never repeated in one run. */
let requestSeq = 0;
export function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq}`;
}

/** Send one JSON body with the shared headers; `extra` may carry Link etc. */
export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Readonly<Record<string, string>> = {}, requestId?: string): void {
  const text = `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'content-type': JSON_TYPE, ...extra };
  headers['x-github-request-id'] = requestId ?? nextRequestId();
  res.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** GitHub's error body: a string message plus optional fields (422 details, 401 docs url). */
export function sendError(res: ServerResponse, status: number, message: string, extraBody: Record<string, unknown> = {}, extraHeaders: Readonly<Record<string, string>> = {}): void {
  sendJson(res, status, { message, ...extraBody }, extraHeaders);
}

/** The bearer token of a request, or null (GitHub's scheme is `Bearer` / `token`). */
export function bearerTokenOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  return match === null || match[1] === '' ? null : (match[1] as string);
}

/** Whether a request is authorized against the suite's token (MAKEFUN_SHOP_TOKEN; empty token disables auth). */
export function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken === '') return true;
  return bearerTokenOf(req) === expectedToken;
}

/** Read the whole body, byte-capped; a JSON parse failure is the caller's signal to answer 400 / -32700. */
export function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; null when it does not parse (the caller answers 400). */
export function parseJsonBody(body: Buffer): unknown | null {
  try {
    return JSON.parse(body.length === 0 ? 'null' : body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}
