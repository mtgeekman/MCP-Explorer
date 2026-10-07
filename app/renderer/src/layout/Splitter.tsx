// A drag handle on a pane's edge: pointer drag, arrow keys, Home and End,
// and a double-click that collapses or restores when the pane can.
// The pane's size is its parent's state; this only reports new sizes.
import { useRef } from 'react';
import { dragSize, growArrow, keySize, type Bounds, type Edge } from '../lib/panes';

export function Splitter({ axis, edge = 'near', size, bounds, label, onResize, onCommit, onToggle }: {
  /** 'y' drags up and down; 'x' drags sideways. */
  axis: 'x' | 'y';
  /** 'near' sits above or left of its pane (the default); 'far' below or right of it. */
  edge?: Edge;
  size: number;
  /** Measured when a drag or a key press starts, since the window may have changed. */
  bounds: () => Bounds;
  label: string;
  onResize: (size: number) => void;
  /** A drag or a key press finished: the size to remember. */
  onCommit: (size: number) => void;
  onToggle?: () => void;
}) {
  const drag = useRef<{ start: number; pos: number; bounds: Bounds; last: number } | null>(null);
  const pos = (e: React.PointerEvent) => (axis === 'y' ? e.clientY : e.clientX);
  const b = bounds();

  return (
    <div
      className={`splitter ${axis}`}
      role="separator"
      aria-orientation={axis === 'y' ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={b.min}
      aria-valuemax={Math.max(b.min, b.max)}
      tabIndex={0}
      title={onToggle ? `${label}: drag, or double-click to collapse or restore` : `${label}: drag`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { start: size, pos: pos(e), bounds: bounds(), last: size };
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = dragSize(d.start, d.pos, pos(e), d.bounds, edge);
        onResize(d.last);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        if (d && d.last !== d.start) onCommit(d.last);
      }}
      onDoubleClick={onToggle}
      onKeyDown={(e) => {
        const next = keySize(e.key, e.shiftKey, size, bounds(), growArrow(axis, edge));
        if (next === undefined) return;
        e.preventDefault();
        onResize(next);
        onCommit(next);
      }}
    />
  );
}
