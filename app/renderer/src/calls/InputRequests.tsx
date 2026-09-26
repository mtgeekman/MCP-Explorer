// Answering what a server asks (phase 08; boards 6.3 and 6.4). One card per
// request: sampling typed as a reply (the human is the model, D16), a form
// elicitation through the form engine and the JSON editor (D9), a URL shown
// whole and opened only on a click (decision 9), roots as lines, anything
// else as a JSON result. The modern era answers a set in one retry; the
// legacy era answers each request on its own, or refuses it.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AwaitedInput, ServerRequestRow, Verdict } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { editorText, parseEditor, planForm, type Args } from '../lib/schemaForm';
import {
  allAnswered, defaultRefusal, deprecationNote, elicitResult, HUMAN_MODEL, nonFileRoots, parseResult, requestedSchema, requestKind, rootsResult,
  samplingResult, samplingView, urlView, type ElicitAction,
} from '../lib/inputRequests';
import { Fields } from './Fields';

type Answer = Record<string, unknown> | undefined;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A URL the server wants the person to visit: the whole of it, its host called out, opened only on a click. */
export function UrlBox({ url, message }: { url: unknown; message?: unknown }) {
  const v = urlView(url);
  const [note, setNote] = useState<string | null>(null);
  const open = async () => {
    const opened = await window.mcpxShell?.openExternal(v.url);
    setNote(opened ? 'Opened in your browser.' : 'The app did not open it.');
  };
  return (
    <div className="url-box">
      {typeof message === 'string' && <p>{message}</p>}
      {v.host && <p>Goes to <strong className="mono">{v.host}</strong>{v.scheme ? <span className="muted"> over {v.scheme}</span> : null}</p>}
      <pre className="mono json url-full">{v.url}</pre>
      {v.warnings.map((w) => <p key={w} className="warn">{w}</p>)}
      <div className="actions left">
        <button onClick={() => void navigator.clipboard?.writeText(v.url)}>Copy URL</button>
        {v.openable && window.mcpxShell && <button onClick={() => void open()}>Open in browser</button>}
        <span className="muted">Nothing opens unless you press Open.</span>
      </div>
      {note && <p className="muted">{note}</p>}
    </div>
  );
}

/**
 * One request and the answer being written for it. Controlled: the answer
 * goes up through onAnswer, undefined while there is none to send.
 */
export function InputRequestCard({ client, method, params, era, label, onAnswer }: {
  client: BackendClient;
  method: unknown;
  params: unknown;
  era: 'legacy' | 'modern';
  /** The server's key (modern) or the request id (legacy). */
  label: string;
  onAnswer: (answer: Answer) => void;
}) {
  const kind = requestKind(method, params);
  const note = deprecationNote(kind, era);
  return (
    <div className="input-card">
      <div className="input-card-head">
        <span className="mono">{String(method)}</span>
        <span className="muted mono">{label}</span>
      </div>
      {note && <p className="muted">{note}</p>}
      {kind === 'sampling' && <SamplingAnswer params={params} onAnswer={onAnswer} />}
      {kind === 'elicitation-form' && <ElicitFormAnswer client={client} params={params} onAnswer={onAnswer} />}
      {kind === 'elicitation-url' && <ElicitUrlAnswer params={params} onAnswer={onAnswer} />}
      {kind === 'roots' && <RootsAnswer onAnswer={onAnswer} />}
      {kind === 'other' && <RawAnswer params={params} onAnswer={onAnswer} note="No revision defines this request, or its shape is one the app does not render. Write the result the server should get." />}
    </div>
  );
}

function SamplingAnswer({ params, onAnswer }: { params: unknown; onAnswer: (a: Answer) => void }) {
  const view = useMemo(() => samplingView(params), [params]);
  const [text, setText] = useState('');
  const [model, setModel] = useState(HUMAN_MODEL);
  const [raw, setRaw] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  useEffect(() => {
    if (raw !== null) {
      const parsed = parseResult(raw);
      setRawError('error' in parsed ? parsed.error : null);
      onAnswer('error' in parsed ? undefined : parsed.result);
    } else {
      onAnswer(text.trim() === '' ? undefined : samplingResult(text, model));
    }
  }, [text, model, raw]);
  return (
    <>
      <p className="muted">The server asks a model for a reply. You are the model: what you write is sent as its answer.</p>
      {view.systemPrompt !== undefined && <><h5>System prompt</h5><pre className="mono json">{view.systemPrompt}</pre></>}
      <h5>Messages</h5>
      {view.messages.length === 0 && <p className="muted">None.</p>}
      {view.messages.map((m, i) => (
        <div key={i} className="sampling-message">
          <span className="muted">{m.role}</span>
          {m.text !== null ? <pre className="json">{m.text}</pre> : <pre className="mono json">{m.json}</pre>}
        </div>
      ))}
      <p className="muted">
        {view.maxTokens !== undefined ? `maxTokens ${JSON.stringify(view.maxTokens)}. ` : ''}
        {view.modelHints.length ? `Model hints: ${view.modelHints.join(', ')}. ` : ''}
        {view.includeContext ? `includeContext ${view.includeContext} (deprecated in 2025-11-25). ` : ''}
        {view.tools.length ? `Tools offered: ${view.tools.join(', ')}${view.toolChoice ? `, toolChoice ${view.toolChoice}` : ''}. A tool_use answer is written in the JSON editor.` : ''}
      </p>
      {view.other && <><h5>Other params</h5><pre className="mono json">{view.other}</pre></>}
      {raw === null ? (
        <>
          <label className="field"><span>Your reply</span>
            <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label="Sampling reply" />
          </label>
          <label className="field"><span>Model name reported</span>
            <input className="mono" value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          <button onClick={() => setRaw(JSON.stringify(samplingResult(text, model), null, 2))}>Edit the whole result as JSON</button>
        </>
      ) : (
        <>
          <label className="field"><span>The result, as JSON (CreateMessageResult)</span>
            <textarea className="mono" rows={8} spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} aria-label="Sampling result as JSON" />
          </label>
          {rawError && <p className="error">Not sent until it parses: {rawError}</p>}
          <button onClick={() => setRaw(null)}>Back to a typed reply</button>
        </>
      )}
    </>
  );
}

function ActionChoice({ action, onChange, acceptLabel }: { action: ElicitAction | null; onChange: (a: ElicitAction) => void; acceptLabel: string }) {
  return (
    <div className="actions left" role="radiogroup" aria-label="Answer">
      {(['accept', 'decline', 'cancel'] as const).map((a) => (
        <label key={a} className="inline">
          <input type="radio" checked={action === a} onChange={() => onChange(a)} /> {a === 'accept' ? acceptLabel : a === 'decline' ? 'Decline' : 'Cancel (dismiss without choosing)'}
        </label>
      ))}
    </div>
  );
}

function ElicitFormAnswer({ client, params, onAnswer }: { client: BackendClient; params: unknown; onAnswer: (a: Answer) => void }) {
  // The request's own schema, in the order the server wrote its keys (decision 10).
  const schema = useMemo(() => requestedSchema(params), [params]);
  const plan = useMemo(() => planForm(schema), [schema]);
  const message = (params as { message?: unknown } | null)?.message;
  const [args, setArgs] = useState<Args>({});
  const [text, setText] = useState(editorText({}));
  const [editorError, setEditorError] = useState<string | null>(null);
  const [action, setAction] = useState<ElicitAction | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const fromForm = (next: Args) => { setArgs(next); setText(editorText(next)); setEditorError(null); };
  const fromEditor = (t: string) => {
    setText(t);
    const parsed = parseEditor(t);
    if ('error' in parsed) return setEditorError(parsed.error);
    setEditorError(null);
    setArgs(parsed.args);
  };
  const validating = useRef(0);
  useEffect(() => {
    if (schema === undefined || action !== 'accept') return;
    const mine = ++validating.current;
    const t = setTimeout(() => {
      client.request('calls.validate', { schema, value: args }).then((v) => { if (mine === validating.current) setVerdict(v); }, () => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [client, schema, args, action]);
  useEffect(() => {
    if (action === null || (action === 'accept' && editorError !== null)) return onAnswer(undefined);
    onAnswer(elicitResult(action, action === 'accept' ? args : undefined));
  }, [action, args, editorError]);
  return (
    <>
      {typeof message === 'string' && <p>{message}</p>}
      <ActionChoice action={action} onChange={setAction} acceptLabel="Accept with these values" />
      {action === 'accept' && (
        <div className="call-inputs">
          <div className="call-form">
            <h5>Form</h5>
            {plan.kind === 'editor-only'
              ? <p className="muted">{plan.reason} The JSON editor beside this takes any values.</p>
              : plan.fields.length === 0 ? <p className="muted">No fields are asked for.</p>
                : <Fields fields={plan.fields} args={args} onChange={fromForm} />}
          </div>
          <div className="call-editor">
            <h5>JSON</h5>
            <textarea className="mono" spellCheck={false} value={text} onChange={(e) => fromEditor(e.target.value)} aria-label="Elicitation content as JSON" />
            {editorError && <p className="error">Not sent until it parses: {editorError}</p>}
          </div>
        </div>
      )}
      {action === 'accept' && verdict?.valid === false && <p className="warn">The values do not match the requested schema: {verdict.message}. They can still be sent; the server decides.</p>}
      {action === 'accept' && verdict?.valid === null && <p className="muted">The schema could not be used to check the values: {verdict.message}</p>}
    </>
  );
}

function ElicitUrlAnswer({ params, onAnswer }: { params: unknown; onAnswer: (a: Answer) => void }) {
  const p = (params ?? {}) as { url?: unknown; message?: unknown; elicitationId?: unknown };
  const [action, setAction] = useState<ElicitAction | null>(null);
  useEffect(() => { onAnswer(action === null ? undefined : elicitResult(action)); }, [action]);
  return (
    <>
      <p className="muted">The server asks you to visit a page outside the app. Check where it goes before you open it.</p>
      <UrlBox url={p.url} message={p.message} />
      {typeof p.elicitationId === 'string' && <p className="muted mono">elicitationId {p.elicitationId}</p>}
      <ActionChoice action={action} onChange={setAction} acceptLabel="Accept (I will visit it)" />
    </>
  );
}

function RootsAnswer({ onAnswer }: { onAnswer: (a: Answer) => void }) {
  const [text, setText] = useState('');
  // An empty list is an answer only when the person says so, never by default.
  const [none, setNone] = useState(false);
  const parsed = useMemo(() => rootsResult(text), [text]);
  useEffect(() => {
    if (none) return onAnswer({ roots: [] });
    onAnswer('error' in parsed || parsed.roots.length === 0 ? undefined : parsed);
  }, [parsed, none]);
  const odd = 'error' in parsed ? [] : nonFileRoots(parsed.roots);
  return (
    <>
      <p className="muted">The server asks which folders it may work in. One URI per line, then a name if you like. Nothing is shared but what you write.</p>
      <label className="inline"><input type="checkbox" checked={none} onChange={(e) => setNone(e.target.checked)} /> Answer with no roots</label>
      {!none && <textarea className="mono" rows={3} value={text} placeholder="file:///home/me/project  project" onChange={(e) => setText(e.target.value)} aria-label="Roots, one per line" />}
      {!none && 'error' in parsed && <p className="error">{parsed.error}</p>}
      {!none && odd.length > 0 && <p className="warn">Not file:// URIs, which the revisions' prose expects: {odd.join(', ')}. They can still be sent.</p>}
    </>
  );
}

function RawAnswer({ params, onAnswer, note }: { params: unknown; onAnswer: (a: Answer) => void; note: string }) {
  const [text, setText] = useState('');
  const parsed = useMemo(() => parseResult(text), [text]);
  useEffect(() => { onAnswer('error' in parsed ? undefined : parsed.result); }, [parsed]);
  return (
    <>
      <p className="muted">{note}</p>
      <pre className="mono json">{JSON.stringify(params, null, 2) ?? 'undefined'}</pre>
      <textarea className="mono" rows={4} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} aria-label="Result as JSON" />
      {'error' in parsed && text.trim() !== '' && <p className="error">Not sent until it parses: {parsed.error}</p>}
    </>
  );
}

/**
 * The modern era's set (board 6.3): one card per key, one retry. Every key
 * needs an answer before anything is sent (decision 6).
 */
export function InputSet({ client, callId, input }: { client: BackendClient; callId: number; input: AwaitedInput }) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = input.inputRequests;
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.request('calls.answer', asked ? { callId, inputResponses: answers as Record<string, unknown> } : { callId });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!asked) {
    return (
      <div className="input-set">
        <p>The server asks to be called again with its state, and asks you for nothing.</p>
        <div className="actions left">
          <button className="primary" disabled={busy} onClick={() => void send()}>Retry</button>
          <span className="muted">Nothing is retried until you press this. The retry gets a new request id and sends requestState back unchanged.</span>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }
  const ready = allAnswered(asked, answers);
  return (
    <div className="input-set">
      <p>The server needs {Object.keys(asked).length === 1 ? 'one answer' : `${Object.keys(asked).length} answers`} before it can go on (round {input.round}).</p>
      {Object.entries(asked).map(([key, req]) => {
        const r = (req ?? {}) as { method?: unknown; params?: unknown };
        return (
          <InputRequestCard key={`${input.round}:${key}`} client={client} method={r.method} params={r.params} era="modern" label={`key ${key}`}
            onAnswer={(a) => setAnswers((prev) => ({ ...prev, [key]: a }))} />
        );
      })}
      <div className="actions left">
        <button className="primary" disabled={!ready || busy} onClick={() => void send()}>Send answers and retry</button>
        <span className="muted">Nothing is retried until you press this. The retry gets a new request id and sends requestState back unchanged.</span>
      </div>
      {!ready && <p className="muted">Answer every request to send. To say no to all of it, stop the call.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** A legacy server's pending request: answer it, or refuse it with an error (decision 5). */
export function ServerRequestCard({ client, row }: { client: BackendClient; row: ServerRequestRow }) {
  const params = row.live?.params ?? row.params;
  const [answer, setAnswer] = useState<Answer>(undefined);
  const refusal = defaultRefusal(row.method);
  const [refusing, setRefusing] = useState(false);
  const [code, setCode] = useState(String(refusal.code));
  const [message, setMessage] = useState(refusal.message);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const codeNumber = Number(code);
  return (
    <div className="server-request">
      <InputRequestCard client={client} method={row.method} params={params} era="legacy" label={`id ${row.jsonrpcId}${row.callId !== null ? `, during call ${row.callId}` : ''}`} onAnswer={setAnswer} />
      <div className="actions left">
        <button className="primary" disabled={busy || answer === undefined} onClick={() => void act(() => client.request('requests.answer', { requestId: row.id, answer: { result: answer! } }))}>Send reply</button>
        <button disabled={busy} onClick={() => setRefusing((r) => !r)}>Refuse</button>
        <span className="muted">The server waits until you answer. Nothing is sent for you.</span>
      </div>
      {refusing && (
        <div className="refusal">
          <label className="field"><span>Error code</span><input className="mono" value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <label className="field"><span>Message</span><input value={message} onChange={(e) => setMessage(e.target.value)} /></label>
          <button className="danger" disabled={busy || !Number.isSafeInteger(codeNumber)} onClick={() => void act(() => client.request('requests.answer', { requestId: row.id, answer: { error: { code: codeNumber, message } } }))}>Send refusal</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
