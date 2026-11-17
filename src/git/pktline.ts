// git/pktline.ts — git's pkt-line framing: `4-hex(payload+4)` then the payload; 0000 flush,
// 0001 delim, 0002 response-end. Max payload 65516 bytes (LARGE_PACKET_MAX 65520 minus the header).

import { Buffer } from 'node:buffer';

/** git's largest packet, header included. */
export const PKT_LINE_MAX = 65520;
/** The largest payload a data packet may carry. */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

/** One decoded packet. `raw` is the exact framed bytes (needed when re-emitting an unparsed section). */
export type Packet =
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer }
  | { readonly kind: 'flush'; readonly raw: Buffer }
  | { readonly kind: 'delim'; readonly raw: Buffer }
  | { readonly kind: 'response-end'; readonly raw: Buffer };

/** Encode one data packet. Throws when the payload is over the maximum (callers split first). */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error(`pkt-line payload is ${data.length} bytes, over ${PKT_LINE_MAX_PAYLOAD}`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet 0000. */
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
/** The delimiter packet 0001. */
export const PKT_DELIM = Buffer.from('0001', 'ascii');
/** The response-end packet 0002. */
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode a mixed sequence; the three control strings stand for the control packets. */
export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Incremental decoder: `feed` a chunk, `next` a packet at a time. A truncated trailing packet stays
 * buffered until the next feed, so a request body split across TCP segments parses the same.
 */
export class PktDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /** The next packet, or null when the buffer holds no complete one. */
  next(): Packet | null {
    if (this.buffer.length < 4) return null;
    const lengthText = this.buffer.toString('ascii', 0, 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) throw new Error(`bad pkt-line length ${JSON.stringify(lengthText)}`);
    const length = Number.parseInt(lengthText, 16);
    if (length === 0) {
      this.buffer = this.buffer.subarray(4);
      return { kind: 'flush', raw: Buffer.from('0000', 'ascii') };
    }
    if (length === 1) {
      this.buffer = this.buffer.subarray(4);
      return { kind: 'delim', raw: Buffer.from('0001', 'ascii') };
    }
    if (length === 2) {
      this.buffer = this.buffer.subarray(4);
      return { kind: 'response-end', raw: Buffer.from('0002', 'ascii') };
    }
    if (length < 4) throw new Error(`pkt-line length ${length} is below 4`);
    if (this.buffer.length < length) return null;
    const raw = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return { kind: 'data', payload: raw.subarray(4), raw };
  }

  /** Everything still buffered (the raw pack bytes after a section's last flush, for receive-pack). */
  rest(): Buffer {
    return this.buffer;
  }
}
