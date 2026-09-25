// The raw wire log (board 4.1), docked below the main area: every unit the
// server and the app exchanged, raw by default. The selected row expands in
// place into its exact bytes (4.2B); the readable pane shows the same unit.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogUnit } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { clock, logCounts, logRows } from '../lib/logrows';
import { formatBytes } from '../lib/raw';
import { RawViewer } from './RawViewer';
import { VirtualList, type VirtualListHandle } from './VirtualList';

const ROW = 26;
/** The tallest an expanded row gets; a small unit gets only the rows it needs. */
const EXPANDED = 360;
const RAW_TOOLBAR = 36;
const RAW_ROW = 18;

function expandedHeight(u: LogUnit): number {
  if (!u.bytes) return ROW + 40;
  let lines = 1;
  for (let i = 0; i < Math.min(u.bytes.length, 4096); i++) if (u.bytes[i] === 0x0a) lines++;
  const rows = Math.max(1, lines + Math.ceil(u.byteLength / 120));
  return Math.min(EXPANDED, ROW + RAW_TOOLBAR + rows * RAW_ROW + 6);
}
const PAGE = 500;

export function WireLog({ client, serverId, selected, onSelect }: {
  client: BackendClient; serverId: string; selected: LogUnit | null; onSelect: (u: LogUnit | null) => void;
}) {
  const [units, setUnits] = useState<LogUnit[]>([]);
  const [complete, setComplete] = useState(false);
  const list = useRef<VirtualListHandle | null>(null);
  const loading = useRef(false);

  useEffect(() => {
    let live = true;
    setUnits([]);
    setComplete(false);
    void client.request('log.units', { serverId, limit: PAGE }).then((page) => {
      if (!live) return;
      setUnits((current) => [...page, ...current.filter((u) => !page.some((p) => p.id === u.id && !p.reserialized))]);
      setComplete(page.length < PAGE);
      requestAnimationFrame(() => list.current?.scrollToBottom());
    });
    const off = client.on((name, data) => {
      if (name !== 'log.unit') return;
      const u = data as LogUnit;
      if (u.serverId !== serverId) return;
      const follow = list.current?.atBottom() ?? true;
      setUnits((current) => (current.some((c) => c.id === u.id && !c.reserialized) ? current : [...current, u]));
      if (follow) requestAnimationFrame(() => list.current?.scrollToBottom());
    });
    return () => { live = false; off(); };
  }, [client, serverId]);

  const loadEarlier = useCallback(async () => {
    if (complete || loading.current || units.length === 0) return;
    loading.current = true;
    const first = units[0];
    try {
      const page = await client.request('log.units', { serverId, limit: PAGE, before: { at: first.at, id: first.id, reserialized: Boolean(first.reserialized) } });
      setUnits((current) => [...page, ...current]);
      setComplete(page.length < PAGE);
      requestAnimationFrame(() => list.current?.scrollToIndex(page.length, 'start'));
    } finally {
      loading.current = false;
    }
  }, [client, serverId, units, complete]);

  const rows = useMemo(() => logRows(units), [units]);
  const counts = useMemo(() => logCounts(units), [units]);
  const selectedIndex = selected ? rows.findIndex((r) => r.unit.id === selected.id && Boolean(r.unit.reserialized) === Boolean(selected.reserialized)) : -1;

  return (
    <section className="wire-log">
      <div className="log-head">
        <span>Wire log</span>
        <span className="muted">
          {counts.frames} messages, {counts.stderr} stderr, {counts.app} app events{counts.other ? `, ${counts.other} other` : ''}
          {complete ? '' : ' (more above)'}
        </span>
      </div>
      {rows.length === 0 ? <p className="muted pad">Nothing yet. Every byte this server sends or receives appears here.</p> : (
        <VirtualList
          className="log-rows"
          count={rows.length}
          rowHeight={ROW}
          expanded={selectedIndex >= 0 ? selectedIndex : undefined}
          expandedHeight={selectedIndex >= 0 ? expandedHeight(rows[selectedIndex].unit) : 0}
          handleRef={list}
          onScrollTop={loadEarlier}
          render={(i) => {
            const r = rows[i];
            const isSelected = i === selectedIndex;
            return (
              <div className={`log-row ${r.unit.kind} ${isSelected ? 'selected' : ''}`}>
                <button className="log-line" onClick={() => onSelect(isSelected ? null : r.unit)} aria-expanded={isSelected}>
                  <span className="t mono">{clock(r.unit.at)}</span>
                  <span className={`dir ${r.unit.direction}`}>{r.arrow}</span>
                  <span className="kind">{r.unit.kind === 'wire' ? '' : r.unit.kind}</span>
                  <span className="label">{r.label}</span>
                  <span className="elapsed mono">{r.elapsedMs !== undefined ? `${r.elapsedMs} ms` : ''}</span>
                  <span className="size mono">{formatBytes(r.unit.byteLength)}</span>
                  <span className="preview mono">{r.preview}</span>
                </button>
                {isSelected && (r.unit.bytes
                  ? <RawViewer bytes={r.unit.bytes} height={expandedHeight(r.unit) - ROW - 2} />
                  : <p className="muted pad">Withheld: this workspace does not keep results.</p>)}
              </div>
            );
          }}
        />
      )}
    </section>
  );
}
