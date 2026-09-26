// Every notification the server sent, both eras, one timeline (phase 10
// decision 6), read from the wire log. Each row shows its params exactly as
// sent beside a one-line summary (D10).
import { useCallback, useEffect, useState } from 'react';
import type { LogUnit, NotificationRow } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { clock } from '../lib/logrows';
import { ARRIVAL_ORDER_NOTE, notificationSummary } from '../lib/session';

const PAGE = 200;

export function NotificationsPanel({ client, serverId, modernStdio }: { client: BackendClient; serverId: string; modernStdio: boolean }) {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    client.request('notifications.list', { serverId, limit: PAGE }).then(setRows, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, serverId]);
  useEffect(() => {
    load();
    return client.on((name, data) => {
      if (name === 'log.purged') load();
      if (name !== 'log.unit') return;
      const unit = data as LogUnit;
      if (unit.serverId === serverId && unit.direction === 'in' && unit.frames.some((f) => f.method !== null && f.jsonrpcId === null)) load();
    });
  }, [client, serverId, load]);

  return (
    <section className="notifications">
      <div className="surface-head">
        <h3>Notifications</h3>
        <span className="muted">{rows.length === 0 ? 'None yet.' : `${rows.length}${rows.length === PAGE ? '+' : ''}, oldest first.`}</span>
        <span className="header-spacer" />
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
                <td>{notificationSummary(n)}</td>
                <td className="mono raw-params">{JSON.stringify(n.params)}</td>
              </tr>
            ))}
          </tbody></table>
        </>
      )}
    </section>
  );
}
