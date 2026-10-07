import type { SizeStore } from '../lib/panes';

/** The renderer's own storage for pane sizes; absent where the page cannot reach it. */
export function paneStore(): SizeStore | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
