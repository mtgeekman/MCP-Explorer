// A call the server refused for authorization (plan phase 11 decisions 2,
// 10 and 11): what it said, and the one button that answers it. Refresh and
// retry refreshes, then starts the same call again through the confirm gate;
// a step-up signs in with more scope and leaves the call for the user to send.
import { useEffect, useState } from 'react';
import type { AuthReport, CallRecord } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { callAuthOffer } from '../lib/auth';

export function AuthOffer({ client, call, onReplay }: {
  client: BackendClient;
  call: CallRecord;
  onReplay?: (args: Record<string, unknown>) => void;
}) {
  const [report, setReport] = useState<AuthReport | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const last = call.roundRecords[call.roundRecords.length - 1];

  useEffect(() => {
    void client.request('auth.get', { serverId: call.serverId }).then(setReport, () => setReport(null));
    return client.on((name, data) => {
      if (name === 'auth.changed' && (data as { serverId: string }).serverId === call.serverId) void client.request('auth.get', { serverId: call.serverId }).then(setReport, () => undefined);
    });
  }, [client, call.serverId]);

  const offer = callAuthOffer(last?.error, report);
  if (!offer) return null;
  const args = (call.roundRecords[0]?.arguments ?? {}) as Record<string, unknown>;

  const press = async () => {
    setBusy(true);
    setNote(null);
    try {
      if (offer.kind === 'refresh-retry') {
        await client.request('auth.refresh', { serverId: call.serverId });
        const reply = await client.request('calls.start', { serverId: call.serverId, kind: call.kind, target: call.target, args });
        if (reply.started) setNote('Refreshed, and the call was sent again: it is the newest in the history.');
        else if (onReplay) {
          onReplay(args);
          setNote('Refreshed. This call asks first, so its arguments are back in the form: press Call to send it.');
        } else setNote('Refreshed. This call asks first: call it again from its form.');
      } else {
        await client.request('auth.signIn', { serverId: call.serverId, ...(offer.scope ? { scope: offer.scope } : {}) });
        setNote('The sign-in page is ready under Sign-in on the server\'s page. When it is done, call again.');
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="round auth-offer">
      <p className="warn">{offer.text}</p>
      <div className="actions left"><button className="primary" disabled={busy} onClick={() => void press()}>{offer.label}</button></div>
      {note && <p className="muted">{note}</p>}
    </div>
  );
}
