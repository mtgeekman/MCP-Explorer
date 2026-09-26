// "Requests from the server" (phase 08 decision 5): what a legacy-era server
// has asked the client, the pending ones answerable here, the rest with how
// they ended. Hidden until a server has asked anything.
import { useEffect, useState } from 'react';
import type { ServerRequestRow } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { clock } from '../lib/logrows';
import { serverRequestStatus } from '../lib/content';
import { ServerRequestCard } from './InputRequests';
import { UnitBytes } from './UnitBytes';

export function ServerRequestsPanel({ client, serverId }: { client: BackendClient; serverId: string }) {
  const [rows, setRows] = useState<ServerRequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      client.request('requests.list', { serverId }).then(
        (r) => { if (!stale && mine === seq) setRows(r); },
        (e: unknown) => { if (!stale) setError(e instanceof Error ? e.message : String(e)); },
      );
    };
    load();
    const off = client.on((name, data) => {
      if ((name === 'request.changed' && (data as { serverId: string }).serverId === serverId) || name === 'log.purged') load();
    });
    return () => { stale = true; off(); };
  }, [client, serverId]);

  if (rows.length === 0 && !error) return null;
  const pending = rows.filter((r) => r.live);
  const earlier = rows.filter((r) => !r.live);
  return (
    <section className="server-requests">
      <h3>Requests from the server</h3>
      {error && <p className="error">{error}</p>}
      {pending.length > 0 && <p className="warn">{pending.length === 1 ? 'The server is waiting for your answer.' : `The server is waiting for ${pending.length} answers.`}</p>}
      {pending.map((r) => <ServerRequestCard key={r.id} client={client} row={r} />)}
      {earlier.length > 0 && (
        <details>
          <summary>Earlier requests ({earlier.length})</summary>
          {earlier.map((r) => <EarlierRequest key={r.id} client={client} row={r} />)}
        </details>
      )}
    </section>
  );
}

/** A request that has ended, with the exact bytes of what came and what went back. */
export function EarlierRequest({ client, row }: { client: BackendClient; row: ServerRequestRow }) {
  const [open, setOpen] = useState(false);
  const status = serverRequestStatus(row.status);
  return (
    <div className="earlier-request">
      <button className="linklike" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="mono">{row.method}</span> <span className={`call-status ${status.tone}`}>{status.text}</span> <span className="muted">{clock(row.receivedAt)}{row.callId !== null ? `, during call ${row.callId}` : ''}</span>
      </button>
      {open && (
        <>
          <UnitBytes client={client} unitId={row.requestUnitId} label="Request" missing="The request's bytes are not stored." />
          {row.responseUnitId !== null
            ? <UnitBytes client={client} unitId={row.responseUnitId} label="Answer" missing="" />
            : <p className="muted">{row.status === 'pending' ? 'Not answered yet.' : 'Nothing went back.'}</p>}
        </>
      )}
    </div>
  );
}
