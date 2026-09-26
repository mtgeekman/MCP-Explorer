// Wire units (spec D34): the exact bytes that crossed the wire, cut at the
// boundaries the transport itself defines. Nothing here constructs or
// interprets a JSON-RPC message; it only finds where one unit ends.

export type UnitDirection = 'out' | 'in' | 'local';
export type UnitKind = 'wire' | 'stderr' | 'app';

/**
 * One piece of what crossed the wire or the process boundary. `wire` is
 * protocol traffic: a stdio line with its line ending, an HTTP body, one SSE
 * event. `stderr` is one line the server wrote to stderr. `app` is an event the
 * app itself records, such as a spawn or an exit.
 */
export interface WireUnit {
  direction: UnitDirection;
  kind: UnitKind;
  bytes: Uint8Array;
  /** HTTP details: exchange number, method, URL, headers (secrets replaced, D35), status, framing. */
  http?: HttpDetails;
}

export interface HttpDetails {
  /** Pairs a request with its response; counts from 1 per connection. */
  exchange: number;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  status?: number;
  statusText?: string;
  /**
   * `sse-event` when the bytes are one Server-Sent Event; absent for a whole
   * body. An event the stream ended inside is recognisable from its bytes: it
   * lacks the blank line that ends an event.
   */
  framing?: 'sse-event';
  /**
   * The fields whose values the log replaced with `<secret: field>`: an OAuth
   * exchange's body (pillar amendment 2026-09-26). The stored bytes are not
   * the bytes sent or received, and the raw view says so.
   */
  redacted?: string[];
}

export type UnitListener = (unit: WireUnit) => void;

const LF = 0x0a;
const CR = 0x0d;

/**
 * Bytes of a unit still arriving. Each chunk is scanned once and kept by
 * reference, so a 10 MB line in 64 KB chunks costs linear time, not a rescan
 * of everything held on every chunk.
 */
class Held {
  private parts: Uint8Array[] = [];
  private length = 0;

  add(part: Uint8Array): void {
    if (part.length === 0) return;
    this.parts.push(part);
    this.length += part.length;
  }

  get size(): number {
    return this.length;
  }

  /** Everything held, then `tail`, as one copy; the holder is then empty. */
  take(tail: Uint8Array = new Uint8Array(0)): Uint8Array {
    const out = new Uint8Array(this.length + tail.length);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    out.set(tail, at);
    this.parts = [];
    this.length = 0;
    return out;
  }
}

/**
 * Cuts a byte stream into lines, each keeping its own terminator. A line ends
 * at LF; a CR before it stays in the line, because it is on the wire.
 */
export class LineSplitter {
  private readonly held = new Held();

  /** The complete lines this chunk finishes, in order. */
  push(chunk: Uint8Array): Uint8Array[] {
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let i = chunk.indexOf(LF); i !== -1; i = chunk.indexOf(LF, start)) {
      lines.push(this.held.take(chunk.subarray(start, i + 1)));
      start = i + 1;
    }
    this.held.add(chunk.subarray(start));
    return lines;
  }

  /** Bytes held back waiting for a line terminator. */
  get pending(): number {
    return this.held.size;
  }

  /** Whatever arrived after the last terminator; the splitter is then empty. */
  flush(): Uint8Array | undefined {
    return this.held.size ? this.held.take() : undefined;
  }
}

/**
 * Cuts a Server-Sent Events stream into events, each unit running from the
 * event's first byte through the blank line that ends it. Line terminators are
 * CRLF, LF or a lone CR (WHATWG HTML, "Parsing an event stream"), so a blank
 * line ending in CR is held until the next byte says whether an LF follows.
 */
export class SseEventSplitter {
  private readonly held = new Held();
  /** Bytes in the current line, terminator excluded. */
  private lineLength = 0;
  /** The last byte was a CR that ended a line, so an LF next belongs to it. */
  private afterCr = false;
  /** A blank line ended in CR: the event is over once we know whether an LF follows. */
  private awaitingLf = false;

  push(chunk: Uint8Array): Uint8Array[] {
    const events: Uint8Array[] = [];
    let start = 0;
    const cut = (end: number) => {
      events.push(this.held.take(chunk.subarray(start, end)));
      start = end;
      this.lineLength = 0;
      this.afterCr = false;
    };
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (this.awaitingLf) {
        this.awaitingLf = false;
        if (b === LF) {
          cut(i + 1);
          continue;
        }
        cut(i);
      }
      if (b === LF) {
        if (this.afterCr) {
          this.afterCr = false;
        } else if (this.lineLength === 0) {
          cut(i + 1);
        } else {
          this.lineLength = 0;
        }
      } else if (b === CR) {
        if (this.lineLength === 0) {
          // This CR ends an empty line, whatever ended the one before it.
          this.afterCr = false;
          this.awaitingLf = true;
        } else {
          this.lineLength = 0;
          this.afterCr = true;
        }
      } else {
        this.afterCr = false;
        this.lineLength++;
      }
    }
    this.held.add(chunk.subarray(start));
    return events;
  }

  /**
   * What is left when the stream ends: an event whose final blank line ended
   * in a CR, or an event the stream stopped inside.
   */
  flush(): Uint8Array | undefined {
    this.awaitingLf = false;
    this.lineLength = 0;
    this.afterCr = false;
    return this.held.size ? this.held.take() : undefined;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The data of one SSE event, as the event stream format defines it: the
 * `data` fields joined with LF, one leading space after the colon dropped. Null
 * when the event has no data field or is not valid UTF-8. Used to index and to
 * display a unit; the unit itself stays the bytes.
 */
export function sseEventData(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const data: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
  }
  return data.length ? data.join('\n') : null;
}
