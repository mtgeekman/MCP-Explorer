// A server's calls, newest first (D23): every tool call, prompt get and
// resource read, with how each ended. A row opens its transcript; replaying
// is from the call view, where the arguments can be edited first.
import { useCallback, useEffect, useState } from 'react';
import type { CallListRow, CallView } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { statusLabel } from '../lib/content';
import { clock } from '../lib/logrows';
import { CallTranscript } from './CallTranscript';

const PAGE = 50;

export function CallHistory({ client, serverId, onRead }: { client: BackendClient; serverId: string; onRead: (view: CallView) => void }) {
  const [rows, setRows] = useState<CallListRow[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    client.request('calls.list', { serverId, limit: PAGE }).then((r) => { setRows(r); setMore(r.length === PAGE); setError(null); },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, serverId]);

  useEffect(() => {
    load();
    return client.on((name, data) => {
      if ((name === 'call.changed' && (data as { serverId: string }).serverId === serverId) || name === 'log.purged') load();
    });
  }, [client, serverId, load]);

  const older = async () => {
    const page = await client.request('calls.list', { serverId, before: rows[rows.length - 1]?.id, limit: PAGE });
    setRows((r) => [...r, ...page]);
    setMore(page.length === PAGE);
  };

  return (
    <section className="call-history">
      <div className="surface-head"><h3>Calls</h3><span className="muted">{rows.length === 0 ? 'None yet.' : 'Newest first.'}</span></div>
      {error && <p className="error">{error}</p>}
      {rows.length > 0 && (
        <table className="calls"><tbody>
          {rows.map((c) => {
            const s = statusLabel(c.status, c.live);
            return (
              <tr key={c.id} className={open === c.id ? 'on' : ''} onClick={() => setOpen(open === c.id ? null : c.id)}>
                <td className="muted">{clock(c.startedAt)}</td>
                <td className="mono">{c.kind === 'tool' ? 'call' : c.kind === 'prompt' ? 'get' : 'read'}</td>
                <td className="mono">{c.target}</td>
                <td><span className={`call-status ${s.tone}`}>{s.text}</span></td>
              </tr>
            );
          })}
        </tbody></table>
      )}
      {more && <button onClick={() => void older()}>Older calls</button>}
      {open !== null && <CallTranscript key={open} client={client} callId={open} onRead={onRead} />}
    </section>
  );
}
