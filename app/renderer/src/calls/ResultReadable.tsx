// A call's result as a person reads it, in the readable pane (D10): text,
// images and audio inline, resources, links, structuredContent with the
// app's check against the outputSchema, and anything no revision defines
// shown as its JSON, labelled. The transcript beside it stays raw.
import type { CallView } from '../../../../packages/backend/dist/index.js';
import { readableResult, statusLabel, type Part } from '../lib/content';
import { READABLE_LIMIT } from '../lib/readable';
import { formatBytes } from '../lib/raw';

export function ResultReadable({ view }: { view: CallView }) {
  const { call } = view;
  const status = statusLabel(call.status, view.live);
  const first = call.roundRecords[0];
  const result = first?.result ?? view.sessionResult;
  const size = result === undefined || result === null ? 0 : JSON.stringify(result).length;
  return (
    <div className="readable-body">
      <h4 className="mono">{call.target}</h4>
      <p className={`call-status ${status.tone}`}>{status.text}</p>
      {first?.result === null && view.sessionResult !== undefined && (
        <p className="muted">This workspace does not keep results. What is shown is this session's copy, gone when the app closes.</p>
      )}
      {view.sdkRejected && (
        <details className="sdk-rejected">
          <summary className="warn">The MCP client library refused this result. It is shown as the server sent it.</summary>
          <pre className="mono part-text">{view.sdkRejected}</pre>
        </details>
      )}
      {first?.resultType === 'input_required' && <InputRequired requests={first.inputRequests} />}
      {first?.error !== null && first?.error !== undefined && (
        <><h4>Error</h4><pre className="mono json">{JSON.stringify(first.error, null, 2)}</pre></>
      )}
      {result !== null && result !== undefined && first?.resultType !== 'input_required' && (
        size > READABLE_LIMIT
          ? <p className="muted">{formatBytes(size)} is more than the readable view renders. The raw transcript holds all of it.</p>
          : <Result kind={call.kind} result={result} view={view} />
      )}
    </div>
  );
}

function Result({ kind, result, view }: { kind: 'tool' | 'prompt' | 'resource'; result: unknown; view: CallView }) {
  const r = readableResult(kind, result);
  return (
    <>
      {r.isError && <p className="warn">The tool reports an error (isError). The call itself completed.</p>}
      {r.sections.map((s, i) => (
        <section key={i} className="result-section">
          {s.heading && <h4 className="mono">{s.heading}</h4>}
          {s.parts.length === 0 && <p className="muted">No content.</p>}
          {s.parts.map((p, j) => <PartView key={j} part={p} />)}
        </section>
      ))}
      {r.structuredContent !== undefined && (
        <>
          <h4>structuredContent</h4>
          {view.outputCheck?.valid === true && <p className="ok-line">Matches the outputSchema in the latest capture.</p>}
          {view.outputCheck?.valid === false && <p className="warn">Does not match the outputSchema in the latest capture: {view.outputCheck.message}</p>}
          {view.outputCheck?.valid === null && <p className="muted">The outputSchema could not be used to check it: {view.outputCheck.message}</p>}
          <pre className="mono json">{r.structuredContent}</pre>
        </>
      )}
      {r.other !== undefined && (<><h4>Other fields</h4><pre className="mono json">{r.other}</pre></>)}
    </>
  );
}

function PartView({ part }: { part: Part }) {
  switch (part.kind) {
    case 'text':
      return <pre className="mono part-text">{part.text}</pre>;
    case 'image':
      return part.src
        ? <figure className="part-media"><img src={part.src} alt={`${part.mimeType} image from the server`} /><figcaption className="muted">{part.mimeType}, {formatBytes(part.bytes)}</figcaption></figure>
        : <p className="warn">An image the view cannot show: MIME type "{part.mimeType}" or data that is not base64.</p>;
    case 'audio':
      return part.src
        ? <figure className="part-media"><audio controls src={part.src} /><figcaption className="muted">{part.mimeType}, {formatBytes(part.bytes)}</figcaption></figure>
        : <p className="warn">Audio the view cannot play: MIME type "{part.mimeType}" or data that is not base64.</p>;
    case 'resource':
      return (
        <div className="part-resource">
          <p className="mono">{part.uri}{part.mimeType ? ` (${part.mimeType})` : ''}</p>
          {part.text !== undefined && <pre className="mono part-text">{part.text}</pre>}
          {part.blobBytes !== undefined && <p className="muted">Binary, {formatBytes(part.blobBytes)}. The raw transcript has the base64.</p>}
        </div>
      );
    case 'resource_link':
      return <p className="part-link">Link to a resource: <span className="mono">{part.uri}</span>{part.name ? ` (${part.name})` : ''}. Nothing is read unless you read it.</p>;
    default:
      return (
        <div className="part-unknown">
          <p className="warn">Content of type "{part.type}", which no MCP revision defines. Shown as sent.</p>
          <pre className="mono json">{part.json}</pre>
        </div>
      );
  }
}

function InputRequired({ requests }: { requests: unknown }) {
  return (
    <div className="input-required">
      <p>The server needs input before it can finish, and asked for what is below. Answering and retrying come in a later version; nothing is sent until you do (the server gets no reply if you stop).</p>
      <pre className="mono json">{requests === null || requests === undefined ? 'No input requests: the result carried only a requestState.' : JSON.stringify(requests, null, 2)}</pre>
    </div>
  );
}
