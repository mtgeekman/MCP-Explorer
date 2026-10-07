// A server's version history (plan phase 09, board 7): one row per run of
// captures of one surface, newest first. An identity-only change is a dashed
// row without a version number; a flood of new versions is flagged. A row
// opens its diff against the entry before it, and "Compare with" picks any
// other entry.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { VersionTimeline } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { latestOnly } from '../lib/latest';
import { defaultBase, entryText, unstableLine } from '../lib/versions';
import { VersionDiff } from './VersionDiff';

export function VersionsPanel({ client, serverId }: { client: BackendClient; serverId: string }) {
  const [timeline, setTimeline] = useState<VersionTimeline | null>(null);
  const [open, setOpen] = useState<{ index: number; base: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useMemo(() => latestOnly(), [serverId]);

  const load = useCallback(() => {
    void latest(client.request('versions.list', { serverId }), (t) => { setTimeline(t); setError(null); },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, serverId, latest]);

  useEffect(() => {
    setOpen(null);
    load();
    return client.on((name, data) => {
      if (name === 'surface.changed' && (data as { serverId: string }).serverId === serverId) load();
    });
  }, [client, serverId, load]);

  const entries = timeline?.entries ?? [];
  const unstable = timeline ? unstableLine(timeline) : null;
  const opened = open && entries[open.index] ? open : null;

  return (
    <section className="versions">
      <div className="surface-head">
        <span className="muted">{entries.length === 0 ? 'Nothing captured yet.' : 'Newest first. Each row is a run of captures of one surface.'}</span>
      </div>
      {error && <p className="error">{error}</p>}
      {unstable && <p className="warn">{unstable}</p>}
      {entries.length > 0 && (
        <table className="calls versions-table"><tbody>
          {[...entries].reverse().map((e) => {
            const text = entryText(entries, e.index);
            return (
              <tr key={e.index} data-kind={e.kind} className={`${e.kind === 'identity' ? 'identity' : ''} ${opened?.index === e.index ? 'on' : ''}`}
                onClick={() => setOpen(opened?.index === e.index ? null : { index: e.index, base: defaultBase(e.index) })}>
                <td className="version-title">{text.title}</td>
                <td>{text.detail}{text.sameAs && <span className="muted"> ({text.sameAs})</span>}</td>
                <td className="muted mono">{e.serverVersion ?? ''}</td>
                <td className="muted nowrap">{text.captures}</td>
                <td className="muted nowrap">{new Date(e.lastObservedAt).toLocaleString()}</td>
              </tr>
            );
          })}
        </tbody></table>
      )}
      {opened && (
        <div className="version-open">
          <label className="compare-with">
            <span>Compare {entryText(entries, opened.index).title.toLowerCase()} with</span>
            <select value={opened.base ?? ''} onChange={(ev) => setOpen({ index: opened.index, base: ev.target.value === '' ? null : Number(ev.target.value) })}>
              <option value="">(choose an entry)</option>
              {entries.filter((e) => e.index !== opened.index).map((e) => (
                <option key={e.index} value={e.index}>{entryText(entries, e.index).title} ({new Date(e.firstObservedAt).toLocaleString()})</option>
              ))}
            </select>
          </label>
          {opened.base === null
            ? <p className="muted">{opened.index === 0 ? 'The first capture has nothing before it. ' : ''}Choose an entry to compare with.</p>
            // Always older to newer, whichever of the two was opened. Keyed by
            // the entry, so opening another starts on what the model sees (7.1B).
            : <VersionDiff key={opened.index} client={client} serverId={serverId}
                before={entries[Math.min(opened.base, opened.index)]!.snapshotId} after={entries[Math.max(opened.base, opened.index)]!.snapshotId} />}
        </div>
      )}
    </section>
  );
}
