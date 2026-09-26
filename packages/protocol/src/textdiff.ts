// A line diff for the version views (phase 09 decisions 4 and 6): Myers'
// O(ND) algorithm over lines, bounded by an edit limit, then hunks with
// context. Written here rather than taken as a dependency: it is small, pure,
// and the golden tests pin its output.
//
// The limit is the plan's risk that large context blocks diff slowly: past
// MAX_EDITS changed lines the diff stops, reports itself incomplete, and the
// view shows both texts whole instead. Memory is the square of the edit
// distance, not of the text, so the limit bounds both.

export type LineOp = 'same' | 'removed' | 'added';

export interface DiffLine {
  op: LineOp;
  text: string;
  /** 1-based line number in the text before; absent on an added line. */
  before?: number;
  /** 1-based line number in the text after; absent on a removed line. */
  after?: number;
  /**
   * On a removed line paired with an added one: the span of this line that
   * differs from its pair, as [start, end) offsets. The common prefix and
   * suffix of the two lines are outside it.
   */
  mark?: [number, number];
}

export interface Hunk {
  /** 1-based first line of the hunk in each text; 0 when the hunk holds none of it. */
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: DiffLine[];
}

export interface TextDiff {
  /** False when the edit distance passed the limit: no hunks were made. */
  complete: boolean;
  removed: number;
  added: number;
  hunks: Hunk[];
}

export const MAX_EDITS = 2000;
export const CONTEXT_LINES = 3;

export function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

export function diffText(
  before: string,
  after: string,
  options: { maxEdits?: number; context?: number } = {},
): TextDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffLines(a, b, options.maxEdits ?? MAX_EDITS);
  if (ops === null) return { complete: false, removed: 0, added: 0, hunks: [] };
  return {
    complete: true,
    removed: ops.filter((o) => o.op === 'removed').length,
    added: ops.filter((o) => o.op === 'added').length,
    hunks: toHunks(ops, options.context ?? CONTEXT_LINES),
  };
}

/** Every line of both texts in order, or null when more than `maxEdits` lines differ. */
export function diffLines(a: string[], b: string[], maxEdits: number): DiffLine[] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const middle = myers(a.slice(head, a.length - tail), b.slice(head, b.length - tail), maxEdits);
  if (middle === null) return null;

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ op: 'same', text: a[i]!, before: i + 1, after: i + 1 });
  for (const m of middle) {
    const line: DiffLine = { op: m.op, text: m.text };
    if (m.before !== undefined) line.before = m.before + head + 1;
    if (m.after !== undefined) line.after = m.after + head + 1;
    out.push(line);
  }
  for (let i = tail; i > 0; i--) {
    out.push({ op: 'same', text: a[a.length - i]!, before: a.length - i + 1, after: b.length - i + 1 });
  }
  return out;
}

interface RawOp { op: LineOp; text: string; before?: number; after?: number }

/** V for one value of d, covering diagonals lo..lo+values.length-1. */
interface Frontier { lo: number; values: Int32Array }

function myers(a: string[], b: string[], maxEdits: number): RawOp[] | null {
  const n = a.length;
  const m = b.length;
  // The distance is at least the difference in length: no need to search.
  if (Math.abs(n - m) > maxEdits) return null;
  const limit = Math.min(maxEdits, n + m);

  // v[k] for k in [-limit-1, limit+1], held at index k + offset.
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  v[offset + 1] = 0;
  const trace: Frontier[] = [];

  for (let d = 0; d <= limit; d++) {
    const lo = Math.max(-d - 1, -limit - 1);
    const hi = Math.min(d + 1, limit + 1);
    trace.push({ lo, values: v.slice(lo + offset, hi + offset + 1) });
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!) ? v[k + 1 + offset]! : v[k - 1 + offset]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace);
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Frontier[]): RawOp[] {
  const out: RawOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const { lo, values } = trace[d]!;
    const at = (k: number) => values[k - lo]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ op: 'same', text: a[x - 1]!, before: x - 1, after: y - 1 });
      x--; y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ op: 'added', text: b[prevY]!, after: prevY });
      else out.push({ op: 'removed', text: a[prevX]!, before: prevX });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

function toHunks(lines: DiffLine[], context: number): Hunk[] {
  const changed = lines.map((l, i) => (l.op === 'same' ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) return [];

  // Group changes whose context would touch or overlap.
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const start = Math.max(0, i - context);
    const end = Math.min(lines.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  return ranges.map(([start, end]) => {
    const hunkLines = lines.slice(start, end + 1).map((l) => ({ ...l }));
    markPairs(hunkLines);
    const befores = hunkLines.filter((l) => l.before !== undefined);
    const afters = hunkLines.filter((l) => l.after !== undefined);
    return {
      beforeStart: befores[0]?.before ?? 0,
      beforeCount: befores.length,
      afterStart: afters[0]?.after ?? 0,
      afterCount: afters.length,
      lines: hunkLines,
    };
  });
}

/**
 * Pairs each run of removed lines with the run of added lines right after it,
 * first with first, and marks the span of each pair that differs. A pair with
 * nothing in common is marked whole.
 */
function markPairs(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.op !== 'removed') { i++; continue; }
    let r = i;
    while (r < lines.length && lines[r]!.op === 'removed') r++;
    let s = r;
    while (s < lines.length && lines[s]!.op === 'added') s++;
    const pairs = Math.min(r - i, s - r);
    for (let p = 0; p < pairs; p++) {
      const del = lines[i + p]!;
      const add = lines[r + p]!;
      const [delMark, addMark] = changedSpans(del.text, add.text);
      del.mark = delMark;
      add.mark = addMark;
    }
    i = s;
  }
}

function changedSpans(a: string, b: string): [[number, number], [number, number]] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  // Never split a surrogate pair: the mark is sliced for display.
  if (prefix > 0 && isHigh(a.charCodeAt(prefix - 1))) prefix--;
  if (suffix > 0 && isLow(a.charCodeAt(a.length - suffix))) suffix--;
  return [[prefix, a.length - suffix], [prefix, b.length - suffix]];
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
