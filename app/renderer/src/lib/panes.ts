// The sizes of the wire log and the readable pane: drag, keys, collapse, and
// what this machine remembers. Pure, so node:test covers it without a DOM.
// A size is a view preference, kept per machine in the renderer's storage,
// never in a workspace.

/** The log's header bar, which is all a collapsed log shows (styles.css .log-head). */
export const LOG_HEAD = 32;
/** A log row (WireLog ROW). The log never gets smaller than its header and three rows. */
export const LOG_MIN = LOG_HEAD + 3 * 26;
/** The server view above the log keeps at least this much. */
export const MAIN_MIN = 160;
export const READABLE_MIN = 240;
export const READABLE_DEFAULT = 380;
/** The middle column keeps at least this much beside the readable pane. */
export const CENTER_MIN = 360;

/** One arrow key press moves this far; with Shift, four times as far. */
export const KEY_STEP = 16;

export interface Bounds { min: number; max: number }

export function clamp(size: number, b: Bounds): number {
  const max = Math.max(b.min, b.max);
  return Math.min(max, Math.max(b.min, Math.round(size)));
}

/** How tall the log may be in a column this tall. */
export function logBounds(columnHeight: number): Bounds {
  return { min: LOG_MIN, max: columnHeight - MAIN_MIN };
}

/** How wide the readable pane may be, given the width it and the middle column share. */
export function readableBounds(sharedWidth: number): Bounds {
  return { min: READABLE_MIN, max: sharedWidth - CENTER_MIN };
}

/**
 * A drag's new size. Both handles sit on the pane's near edge (above the
 * log, left of the readable pane), so moving toward the pane shrinks it.
 */
export function dragSize(start: number, startPos: number, pos: number, b: Bounds): number {
  return clamp(start - (pos - startPos), b);
}

/**
 * A key's new size, or undefined for a key the handle ignores. `grow` is the
 * arrow that makes the pane bigger: ArrowUp for the log, ArrowLeft for the
 * readable pane. Home and End go to the smallest and largest.
 */
export function keySize(key: string, shift: boolean, size: number, b: Bounds, grow: 'ArrowUp' | 'ArrowLeft'): number | undefined {
  const shrink = grow === 'ArrowUp' ? 'ArrowDown' : 'ArrowRight';
  const step = KEY_STEP * (shift ? 4 : 1);
  if (key === grow) return clamp(size + step, b);
  if (key === shrink) return clamp(size - step, b);
  if (key === 'Home') return clamp(b.min, b);
  if (key === 'End') return clamp(b.max, b);
  return undefined;
}

export interface SizeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A remembered size, or undefined when none is kept, storage is unavailable, or what is kept is not a size. */
export function readSize(store: SizeStore | undefined, key: string): number | undefined {
  try {
    const raw = store?.getItem(key);
    if (raw === null || raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function readFlag(store: SizeStore | undefined, key: string): boolean {
  try {
    return store?.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** Remembers a size or a flag. A store that refuses (quota, private mode) only costs the memory, never the resize. */
export function remember(store: SizeStore | undefined, key: string, value: number | boolean): void {
  try {
    store?.setItem(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(Math.round(value)));
  } catch {
    // The size still applies for this session; only its memory is lost.
  }
}

export const KEYS = { logHeight: 'mcpx.logHeight', logCollapsed: 'mcpx.logCollapsed', readableWidth: 'mcpx.readableWidth' } as const;
