// A list that renders only the rows in view, so a log of thousands of units
// or a raw view of 65,000 rows scrolls as cheaply as a short one. Rows have
// one height, except one row that may be expanded to a taller one.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';

export interface VirtualListHandle {
  scrollToIndex(index: number, align?: 'start' | 'center'): void;
  atBottom(): boolean;
  scrollToBottom(): void;
}

const OVERSCAN = 8;

export function VirtualList({ count, rowHeight, expanded, expandedHeight = 0, render, className, handleRef, onScrollTop }: {
  count: number;
  rowHeight: number;
  /** The one row drawn taller, if any. */
  expanded?: number;
  expandedHeight?: number;
  render: (index: number) => ReactNode;
  className?: string;
  handleRef?: Ref<VirtualListHandle | null>;
  /** Called when the list is scrolled to its top, to load earlier rows. */
  onScrollTop?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(0);

  const extra = expanded !== undefined && expanded < count ? expandedHeight - rowHeight : 0;
  const top = (i: number) => i * rowHeight + (expanded !== undefined && i > expanded ? extra : 0);
  const total = count * rowHeight + extra;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    setHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!handleRef) return;
    const handle: VirtualListHandle = {
      scrollToIndex(index, align = 'center') {
        const el = box.current;
        if (!el) return;
        const t = top(index);
        el.scrollTop = align === 'start' ? t : Math.max(0, t - el.clientHeight / 2 + rowHeight / 2);
      },
      atBottom() {
        const el = box.current;
        return !el || el.scrollTop + el.clientHeight >= el.scrollHeight - rowHeight;
      },
      scrollToBottom() {
        const el = box.current;
        if (el) el.scrollTop = el.scrollHeight;
      },
    };
    if (typeof handleRef === 'function') handleRef(handle);
    else (handleRef as { current: VirtualListHandle | null }).current = handle;
  });

  // First row whose bottom is below the scroll position: the expanded row
  // shifts everything after it, so search rather than divide.
  let first = Math.floor(scroll / rowHeight);
  if (expanded !== undefined && first > expanded) first = Math.max(expanded, Math.floor((scroll - extra) / rowHeight));
  first = Math.max(0, first - OVERSCAN);
  const rows: ReactNode[] = [];
  for (let i = first; i < count && top(i) < scroll + height + OVERSCAN * rowHeight; i++) {
    rows.push(
      <div key={i} className="vrow" style={{ top: top(i), height: i === expanded ? expandedHeight : rowHeight }}>
        {render(i)}
      </div>,
    );
  }

  return (
    <div ref={box} className={`vlist ${className ?? ''}`} onScroll={(e) => {
      const t = e.currentTarget.scrollTop;
      setScroll(t);
      if (t === 0) onScrollTop?.();
    }}>
      <div style={{ height: total, position: 'relative' }}>{rows}</div>
    </div>
  );
}
