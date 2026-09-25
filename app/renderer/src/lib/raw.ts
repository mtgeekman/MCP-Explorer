// The raw viewer's document (board 4.2B): a unit's exact bytes cut into
// display rows by byte offset, so a 10 MB result opens whole and scrolls
// without being cut short, folded or re-encoded (D10: raw is byte-faithful).
//
// Nothing is hidden. Bytes that are not valid UTF-8 and control bytes are
// shown as \xNN escapes, and each line's own ending is shown as \r\n or \n,
// so what is on screen accounts for every byte.

export type SegmentKind = 'text' | 'escape' | 'eol';

export interface Segment {
  kind: SegmentKind;
  text: string;
  /** Byte offset of the segment's first byte. */
  offset: number;
}

const LF = 0x0a;
const CR = 0x0d;
const TAB = 0x09;
const fatal = new TextDecoder('utf-8', { fatal: true });

/** Bytes in a UTF-8 sequence starting with `lead`, or 0 when `lead` cannot start one. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

const hex = (b: number) => `\\x${b.toString(16).padStart(2, '0')}`;
const isControl = (b: number) => (b < 0x20 && b !== TAB) || b === 0x7f;

export class RawDocument {
  readonly bytes: Uint8Array;
  readonly cols: number;
  /** Byte offset where each row starts; one more entry than rows, ending at the length. */
  private readonly starts: Uint32Array;

  /**
   * @param cols the most bytes a row holds. A row ends early at a line feed,
   *   and never splits a multi-byte character.
   */
  constructor(bytes: Uint8Array, cols = 160) {
    if (cols < 4) throw new RangeError('a row must hold at least one four-byte character');
    this.bytes = bytes;
    this.cols = cols;
    const starts: number[] = [0];
    let s = 0;
    let nextLf = bytes.indexOf(LF);
    while (s < bytes.length) {
      if (nextLf !== -1 && nextLf < s) nextLf = bytes.indexOf(LF, s);
      let end = nextLf !== -1 && nextLf - s < cols ? nextLf + 1 : Math.min(s + cols, bytes.length);
      // Back off from the middle of a character, unless the row would be empty
      // (a run of stray continuation bytes, each shown as an escape anyway).
      if (end < bytes.length && end - s === cols) {
        let e = end;
        while (e > s && (bytes[e] & 0xc0) === 0x80) e--;
        if (e > s) end = e;
      }
      starts.push(end);
      s = end;
    }
    this.starts = Uint32Array.from(bytes.length === 0 ? [0, 0] : starts);
  }

  get rowCount(): number {
    return this.starts.length - 1;
  }

  rowStart(row: number): number {
    return this.starts[row];
  }

  /** The row holding this byte offset. */
  rowOf(offset: number): number {
    let lo = 0;
    let hi = this.rowCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** A row as segments that together account for every byte in it. */
  segments(row: number): Segment[] {
    const start = this.starts[row];
    const end = this.starts[row + 1];
    let bodyEnd = end;
    if (bodyEnd > start && this.bytes[bodyEnd - 1] === LF) bodyEnd--;
    if (bodyEnd > start && bodyEnd < end && this.bytes[bodyEnd - 1] === CR) bodyEnd--;
    const out: Segment[] = [];
    const push = (kind: SegmentKind, text: string, offset: number) => {
      const last = out[out.length - 1];
      if (last && last.kind === kind && kind !== 'eol') last.text += text;
      else out.push({ kind, text, offset });
    };
    let i = start;
    while (i < bodyEnd) {
      const b = this.bytes[i];
      if (isControl(b)) {
        push('escape', hex(b), i);
        i++;
        continue;
      }
      const n = sequenceLength(b);
      if (n === 0 || i + n > bodyEnd) {
        push('escape', hex(b), i);
        i++;
        continue;
      }
      try {
        push('text', fatal.decode(this.bytes.subarray(i, i + n)), i);
        i += n;
      } catch {
        // Overlong, surrogate or bad continuation: the lead byte is shown and
        // the scan resumes at the next byte.
        push('escape', hex(b), i);
        i++;
      }
    }
    if (bodyEnd < end) {
      out.push({ kind: 'eol', text: end - bodyEnd === 2 ? '\\r\\n' : '\\n', offset: bodyEnd });
    }
    return out;
  }

  /**
   * Byte offsets where the query's UTF-8 bytes occur. Case-insensitive
   * matching folds ASCII letters only, so a match is always the same bytes
   * give or take case. Stops at `limit` and says so.
   */
  find(query: string, { caseSensitive = true, limit = 10_000 } = {}): { offsets: number[]; truncated: boolean } {
    const needle = new TextEncoder().encode(query);
    const offsets: number[] = [];
    if (needle.length === 0) return { offsets, truncated: false };
    const fold = (b: number) => (!caseSensitive && b >= 0x41 && b <= 0x5a ? b + 0x20 : b);
    const first = fold(needle[0]);
    const firstUpper = !caseSensitive && first >= 0x61 && first <= 0x7a ? first - 0x20 : first;
    const bytes = this.bytes;
    const last = bytes.length - needle.length;
    let i = 0;
    while (i <= last) {
      // Jump to the next candidate first byte (either case), then compare.
      let a = bytes.indexOf(first, i);
      if (firstUpper !== first) {
        const b = bytes.indexOf(firstUpper, i);
        a = a === -1 ? b : b === -1 ? a : Math.min(a, b);
      }
      if (a === -1 || a > last) break;
      let j = 1;
      while (j < needle.length && fold(bytes[a + j]) === fold(needle[j])) j++;
      if (j === needle.length) {
        offsets.push(a);
        if (offsets.length >= limit) return { offsets, truncated: a + 1 <= last };
      }
      i = a + 1;
    }
    return { offsets, truncated: false };
  }
}

/**
 * The current match, kept inside the matches that exist: the list shrinks
 * under it when Match case is ticked or the query changes.
 */
export function currentMatch(found: { offsets: number[] }, current: number): number {
  return Math.min(Math.max(current, 0), Math.max(found.offsets.length - 1, 0));
}

/** The find box's status line: which match is current, of how many, and where. */
export function matchLabel(query: string, found: { offsets: number[]; truncated: boolean }, current: number): string {
  if (!query) return '';
  if (!found.offsets.length) return 'No match';
  const at = currentMatch(found, current);
  return `${at + 1} of ${found.offsets.length.toLocaleString()}${found.truncated ? '+' : ''} at byte ${found.offsets[at].toLocaleString()}`;
}

/** A byte count as a person reads it. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
