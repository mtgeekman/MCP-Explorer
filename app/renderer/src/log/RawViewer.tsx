// A unit's exact bytes, whole, with byte offsets and find (board 4.2B). Never
// cut short, never folded: the rows are virtual, not the bytes.
import { useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { RawDocument, currentMatch, formatBytes, matchLabel, type Segment } from '../lib/raw';
import { VirtualList, type VirtualListHandle } from './VirtualList';

const ROW = 18;
const utf8Length = (ch: string) => new TextEncoder().encode(ch).length;

/** Rows as wide as the pane: bytes per row from the width and the monospace character width. */
function useColumns() {
  const box = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [cols, setCols] = useState(160);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const charWidth = (probe.current?.getBoundingClientRect().width ?? 750) / 100;
      // Width minus the offset gutter (90 px), the gap and padding (32 px), and the scroll bar.
      setCols(Math.max(16, Math.floor((el.clientWidth - 140) / charWidth)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);
  return { box, probe, cols };
}

export function RawViewer({ bytes, height }: { bytes: Uint8Array; height: number }) {
  const { box, probe, cols } = useColumns();
  const doc = useMemo(() => new RawDocument(bytes, cols), [bytes, cols]);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [current, setCurrent] = useState(0);
  const list = useRef<VirtualListHandle | null>(null);
  const qLen = useMemo(() => new TextEncoder().encode(query).length, [query]);
  const found = useMemo(() => doc.find(query, { caseSensitive }), [doc, query, caseSensitive]);
  const at = currentMatch(found, current);

  const go = (i: number) => {
    if (found.offsets.length === 0) return;
    const next = (i + found.offsets.length) % found.offsets.length;
    setCurrent(next);
    list.current?.scrollToIndex(doc.rowOf(found.offsets[next]));
  };

  /** Match ranges overlapping a row, as [start, end) byte offsets. */
  const matchesIn = (row: number) => {
    const start = doc.rowStart(row);
    const end = row + 1 < doc.rowCount ? doc.rowStart(row + 1) : bytes.length;
    return found.offsets.filter((o) => o < end && o + qLen > start).map((o) => [o, o + qLen, o === found.offsets[at]] as const);
  };

  const renderSegment = (s: Segment, ranges: (readonly [number, number, boolean])[], key: number) => {
    if (s.kind !== 'text' || ranges.length === 0) return <span key={key} className={`seg ${s.kind}`}>{s.text}</span>;
    // Walk the segment a character at a time, tracking its byte offset, and
    // mark the characters inside a match.
    const parts: ReactElement[] = [];
    let offset = s.offset;
    let buf = '';
    let mark: 'no' | 'hit' | 'current' = 'no';
    const flush = (k: string) => {
      if (!buf) return;
      parts.push(mark === 'no' ? <span key={k}>{buf}</span> : <mark key={k} className={mark === 'current' ? 'current' : ''}>{buf}</mark>);
      buf = '';
    };
    for (const ch of s.text) {
      const hit = ranges.find(([a, b]) => offset >= a && offset < b);
      const m = hit ? (hit[2] ? 'current' : 'hit') : 'no';
      if (m !== mark) { flush(`${key}-${offset}`); mark = m; }
      buf += ch;
      offset += utf8Length(ch);
    }
    flush(`${key}-end`);
    return <span key={key} className="seg text">{parts}</span>;
  };

  return (
    <div className="raw-viewer" style={{ height }} ref={box}>
      <span className="mono raw-probe" ref={probe} aria-hidden>{'0'.repeat(100)}</span>
      <div className="raw-toolbar">
        <span className="muted">{formatBytes(bytes.length)}, {doc.rowCount.toLocaleString()} rows, exact bytes</span>
        <input className="mono" placeholder="Find" value={query} onChange={(e) => { setQuery(e.target.value); setCurrent(0); }}
          onKeyDown={(e) => { if (e.key === 'Enter') go(at + (e.shiftKey ? -1 : 1)); }} />
        <label className="inline"><input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> Match case</label>
        <span className="muted">
          {matchLabel(query, found, current)}
        </span>
        <button disabled={!found.offsets.length} onClick={() => go(at - 1)}>Previous</button>
        <button disabled={!found.offsets.length} onClick={() => go(at + 1)}>Next</button>
      </div>
      <VirtualList
        className="raw-rows mono"
        count={doc.rowCount}
        rowHeight={ROW}
        handleRef={list}
        render={(row) => {
          const ranges = query ? matchesIn(row) : [];
          return (
            <div className="raw-row">
              <span className="offset">{doc.rowStart(row).toLocaleString()}</span>
              <span className="bytes">{doc.segments(row).map((s, i) => renderSegment(s, ranges, i))}</span>
            </div>
          );
        }}
      />
    </div>
  );
}
