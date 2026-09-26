// One call as a sequence (D16, D23): each round's request and response as the
// exact bytes that crossed the wire (D10, D34), live progress with Cancel
// (board 6.5), a call waiting for input with its answers (board 6.3) or
// paused at the soft cap (board 6.4), and the requests a legacy server sent
// during it. The readable pane is where the result is read.
import { useEffect, useState } from 'react';
import type { CallExport, CallView, RoundRecord } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { progressText, statusLabel } from '../lib/content';
import { missingCapabilityText, taskActions, taskLine } from '../lib/session';
import { urlElicitationsInError } from '../lib/inputRequests';
import { clock } from '../lib/logrows';
import { InputSet, UrlBox } from './InputRequests';
import { EarlierRequest } from './ServerRequestsPanel';
import { UnitBytes } from './UnitBytes';
import { AuthOffer } from './AuthOffer';

export function CallTranscript({ client, callId, serverName, onRead, onReplay }: {
  client: BackendClient;
  callId: number;
  /** Named when the call pauses at the soft cap (D21). */
  serverName?: string;
  onRead: (view: CallView) => void;
  onReplay?: (args: Record<string, unknown>) => void;
}) {
  const [view, setView] = useState<CallView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<CallExport | null>(null);

  useEffect(() => {
    let stale = false;
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      client.request('calls.get', { callId }).then(
        (v) => { if (!stale && mine === seq) setView(v); },
        (e: unknown) => { if (!stale) setError(e instanceof Error ? e.message : String(e)); },
      );
    };
    load();
    const off = client.on((name, data) => {
      if (name === 'call.changed' && (data as { callId: number }).callId === callId) load();
    });
    return () => { stale = true; off(); };
  }, [client, callId]);

  // A finished call shows its result in the pane as soon as it ends.
  const ended = view && !view.live;
  useEffect(() => {
    if (view && ended) onRead(view);
  }, [ended, view?.call.status]);

  if (view === undefined) return <p className="muted pad">Loading</p>;
  if (view === null) return <p className="muted pad">This call is no longer in the history: retention purged it.</p>;
  const { call } = view;
  const status = statusLabel(call.status, view.live);
  const act = (work: () => Promise<unknown>) => { setError(null); work().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); };
  const firstArgs = call.roundRecords[0]?.arguments;

  return (
    <section className="transcript">
      <header className="transcript-head">
        <span className={`call-status ${status.tone}`}>{status.text}</span>
        <span className="mono">{call.kind === 'resource' ? 'resources/read' : call.kind === 'prompt' ? 'prompts/get' : 'tools/call'} {call.target}</span>
        <span className="muted">{clock(call.startedAt)}{call.finishedAt !== null ? `, ${call.finishedAt - call.startedAt} ms` : ''}</span>
        <span className="header-spacer" />
        {view.live?.status === 'running' && !view.live.task && <button onClick={() => act(() => client.request('calls.cancel', { callId }))}>Cancel</button>}
        {view.live?.status === 'awaiting-input' && !view.live.task && <button onClick={() => act(() => client.request('calls.stop', { callId }))}>Stop the call</button>}
        {taskActions(view.live).map((a) => (
          <button key={a.op} onClick={() => act(() => (a.op === 'cancel' ? client.request('calls.cancel', { callId }) : a.op === 'stop' ? client.request('calls.stop', { callId }) : client.request('calls.task', { callId, op: a.op })))}>{a.label}</button>
        ))}
        <button onClick={() => onRead(view)}>Read</button>
        {onReplay && firstArgs !== undefined && !view.live && (
          <button title="Load these arguments into the form; nothing is sent until you call" onClick={() => onReplay((firstArgs ?? {}) as Record<string, unknown>)}>Replay</button>
        )}
        {!view.live && <button onClick={() => act(async () => setExported(await client.request('calls.export', { callId })))}>Export</button>}
      </header>
      {view.live?.task && <p className="progress">{taskLine(view.live)}</p>}
      {view.live?.status === 'running' && !view.live.task && (
        <p className="progress">{view.live.progress ? `Progress ${progressText(view.live.progress)}` : 'Waiting for the server.'} Cancel tells the server to stop; it may still finish.</p>
      )}
      {view.live?.status === 'awaiting-input' && view.live.paused && (
        <div className="pause-box">
          <p>
            <strong>{serverName ?? 'The server'}</strong> has asked for input {view.live.paused.rounds} times on {call.target}. The app pauses a call every {view.live.paused.cap} rounds (Settings, "Rounds before pausing a call"), because a server may ask forever.
          </p>
          <div className="actions left">
            <button className="primary" onClick={() => act(() => client.request('calls.continue', { callId }))}>Keep answering</button>
            <button onClick={() => act(() => client.request('calls.stop', { callId }))}>Stop the call</button>
          </div>
        </div>
      )}
      {view.live?.status === 'awaiting-input' && !view.live.paused && view.live.input?.malformed && (
        <p className="warn">The server answered input_required, and the result is malformed: {view.live.input.malformed} It cannot be answered; Stop ends the call.</p>
      )}
      {view.live?.status === 'awaiting-input' && !view.live.paused && view.live.input && !view.live.input.malformed && (
        <InputSet key={view.live.input.round} client={client} callId={callId} input={view.live.input} />
      )}
      {error && <p className="error">{error}</p>}
      {exported && <ExportBox exported={exported} onClose={() => setExported(null)} />}
      {call.roundRecords.map((r) => <Round key={r.seq} client={client} round={r} />)}
      {!view.live && <AuthOffer client={client} call={call} onReplay={onReplay} />}
      {view.serverRequests.length > 0 && (
        <div className="round">
          <h4>Requests from the server during this call</h4>
          {view.serverRequests.some((r) => r.status === 'pending') && <p className="warn">Waiting for your answer under "Requests from the server" on this server's page.</p>}
          {view.serverRequests.map((r) => <EarlierRequest key={r.id} client={client} row={r} />)}
        </div>
      )}
    </section>
  );
}

function Round({ client, round }: { client: BackendClient; round: RoundRecord }) {
  return (
    <div className="round">
      <h4>Round {round.seq}{round.method ? ` (${round.method})` : ''}</h4>
      <UnitBytes client={client} unitId={round.requestUnitId} label="Request" missing="The request never reached the wire." />
      {round.responseUnitId !== null
        ? <UnitBytes client={client} unitId={round.responseUnitId} label="Response" missing="" />
        : <p className="muted">{round.finishedAt === null ? 'No response yet.' : round.error ? `No response: ${JSON.stringify(round.error)}` : 'No response was recorded.'}</p>}
      {round.inputResponses !== null && <p className="muted">Answered, and the answers went in round {round.seq + 1}'s request.</p>}
      {missingCapabilityText(round.error) && <p className="warn">{missingCapabilityText(round.error)}</p>}
      {urlElicitationsInError(round.error).map((e, i) => (
        <div key={i}>
          <p className="warn">The server needs you to visit a page first (error -32042). Visit it, then call again.</p>
          <UrlBox url={e.url} message={e.message} />
        </div>
      ))}
    </div>
  );
}

function ExportBox({ exported, onClose }: { exported: CallExport; onClose: () => void }) {
  const text = exported.bytes ? new TextDecoder().decode(exported.bytes) : null;
  const copy = (s: string) => void navigator.clipboard?.writeText(s);
  return (
    <div className="export-box">
      <div className="actions left">
        <strong>Export</strong>
        <span className="header-spacer" />
        <button onClick={onClose}>Close</button>
      </div>
      {exported.reason && <p className="muted">{exported.reason}</p>}
      {text && (
        <>
          <p className="muted">The request exactly as it was sent. Replaying it elsewhere sends the same id.</p>
          <pre className="mono json">{text}</pre>
          <button onClick={() => copy(text)}>Copy request</button>
        </>
      )}
      {exported.curl && (
        <>
          <p className="muted">
            curl for a POSIX shell (Git Bash, WSL, macOS, Linux), for this HTTP server.{exported.secretVariables?.length ? ` Set ${exported.secretVariables.join(', ')} first: secret values are never in the log, so they are not here.` : ''}
          </p>
          <pre className="mono json">{exported.curl}</pre>
          <button onClick={() => copy(exported.curl!)}>Copy curl</button>
        </>
      )}
    </div>
  );
}
