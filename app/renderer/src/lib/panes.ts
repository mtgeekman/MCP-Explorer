// The sizes of the wire log, the readable pane and the surface list: drag,
// keys, collapse, and what this machine remembers. Pure, so node:test covers it without a DOM.
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
/** The surface's list of entries, left of the entry it opens. */
export const LIST_MIN = 160;
export const LIST_DEFAULT = 260;
/** The entry beside the list keeps at least this much, its padding included; styles.css holds it there when the split narrows. */
export const ENTRY_MIN = 320;

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

/** How wide the surface list may be, given the width it and the entry share. */
export function listBounds(sharedWidth: number): Bounds {
  return { min: LIST_MIN, max: sharedWidth - ENTRY_MIN };
}

/**
 * Which edge of its pane a handle sits on. The log's and the readable pane's
 * handles sit on the near edge (above the log, left of the readable pane);
 * the surface list's sits on its far edge, right of the list.
 */
export type Edge = 'near' | 'far';

/**
 * A drag's new size. A handle on the pane's near edge shrinks the pane as it
 * moves toward it; one on the far edge grows the pane as it moves away.
 */
export function dragSize(start: number, startPos: number, pos: number, b: Bounds, edge: Edge = 'near'): number {
  const moved = pos - startPos;
  return clamp(edge === 'near' ? start - moved : start + moved, b);
}

type Arrow = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
const OPPOSITE: Record<Arrow, Arrow> = { ArrowUp: 'ArrowDown', ArrowDown: 'ArrowUp', ArrowLeft: 'ArrowRight', ArrowRight: 'ArrowLeft' };

/** The arrow that makes a pane bigger, from its handle's axis and edge: ArrowUp for the log, ArrowLeft for the readable pane, ArrowRight for the surface list. */
export function growArrow(axis: 'x' | 'y', edge: Edge): Arrow {
  if (axis === 'y') return edge === 'near' ? 'ArrowUp' : 'ArrowDown';
  return edge === 'near' ? 'ArrowLeft' : 'ArrowRight';
}

/**
 * A key's new size, or undefined for a key the handle ignores. `grow` is the
 * arrow that makes the pane bigger (growArrow); its opposite shrinks it.
 * Home and End go to the smallest and largest.
 */
export function keySize(key: string, shift: boolean, size: number, b: Bounds, grow: Arrow): number | undefined {
  const shrink = OPPOSITE[grow];
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

export const KEYS = { logHeight: 'mcpx.logHeight', logCollapsed: 'mcpx.logCollapsed', readableWidth: 'mcpx.readableWidth', surfaceListWidth: 'mcpx.surfaceListWidth' } as const;
