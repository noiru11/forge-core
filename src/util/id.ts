// util/id.ts — GitHub-shaped opaque ids: GraphQL global ids (`base64("repo:1")`) and page cursors.

/** What a global id can name (the GraphQL `Node` union's members this forge serves). */
export type NodeKind = 'repo' | 'issue' | 'pull' | 'comment' | 'label';

/** One decoded global id. */
export interface NodeRef {
  readonly kind: NodeKind;
  readonly id: number;
  readonly repoId?: number;
}

/** `base64("<kind>:<id>[:<repoId>]")` — opaque to a client, stable across reads (global-id-stability). */
export function encodeGlobalId(kind: NodeKind, id: number, repoId?: number): string {
  const raw = repoId === undefined ? `${kind}:${id}` : `${kind}:${id}:${repoId}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

/** Decode a global id, or null when it is not one this forge minted. */
export function decodeGlobalId(value: string): NodeRef | null {
  let raw: string;
  try {
    raw = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = raw.split(':');
  const kind = parts[0];
  if (kind !== 'repo' && kind !== 'issue' && kind !== 'pull' && kind !== 'comment' && kind !== 'label') return null;
  const id = Number(parts[1]);
  if (!Number.isSafeInteger(id)) return null;
  if (parts.length === 3) {
    const repoId = Number(parts[2]);
    if (Number.isSafeInteger(repoId)) return { kind, id, repoId };
  }
  return { kind, id };
}

/** An opaque cursor for a list offset (GraphQL `pageInfo.endCursor` / `after`). */
export function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64');
}

/** The offset a cursor names, or null when it is not ours (a null/absent `after` is 0). */
export function decodeCursor(cursor: string | null | undefined): number | null {
  if (cursor === null || cursor === undefined || cursor === '') return 0;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    if (!raw.startsWith('o:')) return null;
    const offset = Number(raw.slice(2));
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
  } catch {
    return null;
  }
}
