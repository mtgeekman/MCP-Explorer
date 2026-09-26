// The readable view of the selected unit (board 1A): a right-hand pane with a
// pop-out. The main view stays raw; this is where a person reads.
import { Fragment } from 'react';
import type { CallView, LogUnit } from '../../../../packages/backend/dist/index.js';
import { ResultReadable } from '../calls/ResultReadable';
import { ItemReadable } from '../surface/ItemReadable';
import type { SelectedItem } from '../surface/SurfacePanel';
import { readable } from '../lib/readable';
import { clock } from '../lib/logrows';
import { formatBytes } from '../lib/raw';

/** What the pane shows: a wire log unit, a surface entry (board 5.1A), or a call's result. */
export type ReadableContent = { kind: 'unit'; unit: LogUnit } | { kind: 'item'; item: SelectedItem } | { kind: 'call'; view: CallView };

export function ReadableBody({ content }: { content: ReadableContent | null }) {
  if (!content) return <p className="muted pad">Select a row in the wire log, a surface entry, or a call, to read it here.</p>;
  if (content.kind === 'item') return <ItemReadable selected={content.item} />;
  if (content.kind === 'call') return <ResultReadable view={content.view} />;
  return <UnitReadable unit={content.unit} />;
}

function UnitReadable({ unit }: { unit: LogUnit }) {
  const r = readable(unit);
  const http = unit.http;
  return (
    <div className="readable-body">
      <dl className="facts">
        <dt>When</dt><dd>{clock(unit.at)}</dd>
        <dt>Direction</dt><dd>{unit.direction === 'out' ? 'Sent' : unit.direction === 'in' ? 'Received' : 'App event'}</dd>
        <dt>Size</dt><dd>{formatBytes(unit.byteLength)}</dd>
        {unit.frames.length > 0 && (<><dt>Messages</dt><dd>{unit.frames.map((f) => `${f.method ?? 'unknown'}${f.jsonrpcId ? ` #${f.jsonrpcId}` : ''}`).join(', ')}</dd></>)}
        {http?.method && (<><dt>Request</dt><dd className="mono">{http.method} {http.url}</dd></>)}
        {http?.status !== undefined && (<><dt>Status</dt><dd>{http.status} {http.statusText}</dd></>)}
        {http?.redacted?.length ? (<><dt>Redacted</dt><dd>These bytes are not the wire's: the values of {http.redacted.join(', ')} were replaced before they were stored, as OAuth secrets.</dd></>) : null}
      </dl>
      {http?.headers && Object.keys(http.headers).length > 0 && (
        <details>
          <summary>Headers</summary>
          <table className="headers mono"><tbody>
            {Object.entries(http.headers).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
          </tbody></table>
        </details>
      )}
      {unit.reserialized && <p className="warn">Recorded before exact capture: this is the message as parsed, not the bytes on the wire.</p>}
      {r.kind === 'withheld' && <p className="muted">Withheld: this workspace does not keep results. The row still says what it answered.</p>}
      {r.kind === 'too-large' && <p className="muted">{r.size} is more than the readable view renders. The raw view holds all of it.</p>}
      {r.kind === 'empty' && <p className="muted">No body.</p>}
      {r.kind === 'text' && (<><p className="muted">{r.why}</p><pre className="mono">{r.text}</pre></>)}
      {r.kind === 'app' && <dl className="facts">{r.fields.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>}
      {r.kind === 'json' && (
        <>
          {r.cacheHints.length > 0 && (
            <div className="cache-hints">
              <h4>Cache hints, not surface</h4>
              <p className="muted">Chosen by the server on every response. They are not part of what the server offers, and are never hashed.</p>
              <dl className="facts">{r.cacheHints.map((h) => <Fragment key={h.name}><dt>{h.name}</dt><dd className="mono">{JSON.stringify(h.value)}</dd></Fragment>)}</dl>
            </div>
          )}
          <pre className="mono json">{r.pretty}</pre>
        </>
      )}
    </div>
  );
}

export function ReadablePane({ content, poppedOut, onPopOut, width }: { content: ReadableContent | null; poppedOut: boolean; onPopOut: () => void; width?: number }) {
  return (
    <aside className="readable-pane" style={width === undefined ? undefined : { flexBasis: width }}>
      <div className="pane-head">
        <span>Readable</span>
        {!poppedOut && <button onClick={onPopOut} title="Open this pane in its own window">Pop out</button>}
      </div>
      {poppedOut ? <p className="muted pad">Shown in its own window. Close that window to bring it back here.</p> : <ReadableBody content={content} />}
    </aside>
  );
}
