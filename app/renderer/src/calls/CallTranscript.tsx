// One call as a sequence (D16, D23): each round's request and response as the
// exact bytes that crossed the wire (D10, D34), live progress with Cancel
// (board 6.5), and a call waiting for input with Stop (decision 6). The
// readable pane is where the result is read.
import { useEffect, useState } from 'react';
import type { CallExport, CallView, LogUnit, RoundRecord } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { progressText, statusLabel } from '../lib/content';
import { clock } from '../lib/logrows';
import { RawViewer } from '../log/RawViewer';

export function CallTranscript({ client, callId, onRead, onReplay }: {
  client: BackendClient;
  callId: number;
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
        {view.live?.status === 'running' && <button onClick={() => act(() => client.request('calls.cancel', { callId }))}>Cancel</button>}
        {view.live?.status === 'awaiting-input' && <button onClick={() => act(() => client.request('calls.stop', { callId }))}>Stop the call</button>}
        <button onClick={() => onRead(view)}>Read</button>
        {onReplay && firstArgs !== undefined && !view.live && (
          <button title="Load these arguments into the form; nothing is sent until you call" onClick={() => onReplay((firstArgs ?? {}) as Record<string, unknown>)}>Replay</button>
        )}
        {!view.live && <button onClick={() => act(async () => setExported(await client.request('calls.export', { callId })))}>Export</button>}
      </header>
      {view.live?.status === 'running' && (
        <p className="progress">{view.live.progress ? `Progress ${progressText(view.live.progress)}` : 'Waiting for the server.'} Cancel tells the server to stop; it may still finish.</p>
      )}
      {view.live?.status === 'awaiting-input' && (
        <p className="warn">The server answered input_required. Nothing is retried: answering comes in a later version. Stop ends the call without a reply.</p>
      )}
      {error && <p className="error">{error}</p>}
      {exported && <ExportBox exported={exported} onClose={() => setExported(null)} />}
      {call.roundRecords.map((r) => <Round key={r.seq} client={client} round={r} />)}
    </section>
  );
}

function Round({ client, round }: { client: BackendClient; round: RoundRecord }) {
  return (
    <div className="round">
      <h4>Round {round.seq}</h4>
      <UnitBytes client={client} unitId={round.requestUnitId} label="Request" missing="The request never reached the wire." />
      {round.responseUnitId !== null
        ? <UnitBytes client={client} unitId={round.responseUnitId} label="Response" missing="" />
        : <p className="muted">{round.finishedAt === null ? 'No response yet.' : round.error ? `No response: ${JSON.stringify(round.error)}` : 'No response was recorded.'}</p>}
    </div>
  );
}

function UnitBytes({ client, unitId, label, missing }: { client: BackendClient; unitId: number | null; label: string; missing: string }) {
  const [unit, setUnit] = useState<LogUnit | null | undefined>(undefined);
  useEffect(() => {
    if (unitId === null) return;
    let stale = false;
    client.request('log.get', { id: unitId }).then((u) => { if (!stale) setUnit(u); }, () => { if (!stale) setUnit(null); });
    return () => { stale = true; };
  }, [client, unitId]);
  if (unitId === null) return <p className="muted">{missing}</p>;
  if (unit === undefined) return <p className="muted">Loading {label.toLowerCase()}</p>;
  if (unit === null) return <p className="muted">{label}: purged from the wire log.</p>;
  if (unit.bytes === null) return <p className="muted">{label}: withheld, this workspace does not keep results. The wire log still shows it happened.</p>;
  return (
    <>
      <p className="muted entry-source">{label}: exact bytes, wire log unit {unit.id}</p>
      <RawViewer bytes={unit.bytes} height={Math.min(320, 40 + 18 * Math.ceil(unit.byteLength / 120))} />
    </>
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
