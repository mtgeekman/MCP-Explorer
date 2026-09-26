// Every notification the server sent, both eras, one timeline (phase 10
// decision 6), read from the wire log. The default view is each unit exactly
// as it arrived (D10, R10-4); one-line summaries are the Readable view. Read
// only while open (R10-5).
import { useCallback, useEffect, useState } from 'react';
import type { LogUnit, NotificationRow } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { clock } from '../lib/logrows';
import { ARRIVAL_ORDER_NOTE, notificationSummary, reloadsTimeline } from '../lib/session';

const PAGE = 200;

export function NotificationsPanel({ client, serverId, modernStdio }: { client: BackendClient; serverId: string; modernStdio: boolean }) {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);
  const [readable, setReadable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    client.request('notifications.list', { serverId, limit: PAGE }).then(setRows, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, serverId]);
  useEffect(() => {
    if (!open) return undefined;
    load();
    return client.on((name, data) => {
      if (name === 'log.purged') load();
      if (name === 'log.unit' && reloadsTimeline(open, serverId, data as LogUnit)) load();
    });
  }, [client, serverId, load, open]);

  return (
    <section className="notifications">
      <div className="surface-head">
        <h3>Notifications</h3>
        <span className="muted">{!open ? 'Every notification the server sent, from the wire log.' : rows.length === 0 ? 'None yet.' : `${rows.length}${rows.length === PAGE ? '+' : ''}, oldest first.`}</span>
        <span className="header-spacer" />
        {open && <label className="check"><input type="checkbox" checked={readable} onChange={(e) => setReadable(e.target.checked)} /> Readable</label>}
        <button onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {open && (
        <>
          {modernStdio && <p className="hint">{ARRIVAL_ORDER_NOTE}</p>}
          <table className="calls notifications-table"><tbody>
            {rows.map((n, i) => (
              <tr key={`${n.unitId}:${i}`}>
                <td className="muted">{clock(n.at)}</td>
                <td className="mono">{n.method}</td>
                {readable
                  ? <td>{notificationSummary(n)}</td>
                  : <td className="mono raw-params">{n.raw ?? 'The bytes were purged from the wire log.'}</td>}
              </tr>
            ))}
          </tbody></table>
        </>
      )}
    </section>
  );
}
