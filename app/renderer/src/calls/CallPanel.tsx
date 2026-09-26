// Calling a tool, getting a prompt, reading a resource (board 6.1). The form
// and the JSON editor sit side by side on one arguments value: a field the
// form cannot render is the editor's, and the editor can always write what
// the schema allows (D9). Validation is advisory (decision 4). A tool not
// declared read-only is confirmed first, by the backend's rule (D7).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CallView, ConfirmPrompt, Verdict } from '../../../../packages/backend/dist/index.js';
import type { NormalizedTool } from '../../../../packages/protocol/dist/index.js';
import type { BackendClient } from '../lib/client';
import { ANNOTATIONS_LINE, annotationRows } from '../lib/surface';
import { editorText, parseEditor, planForm, type Args } from '../lib/schemaForm';
import { Fields } from './Fields';
import { CallTranscript } from './CallTranscript';

export type CallTarget =
  | { kind: 'tool'; tool: NormalizedTool }
  | { kind: 'prompt'; name: string; arguments?: unknown }
  | { kind: 'resource'; uri: string }
  | { kind: 'template'; uriTemplate: string };

/** The inputSchema in a tool entry's exact bytes (R07-7), or undefined when they do not parse to one. */
function entryInputSchema(bytes: Uint8Array): unknown {
  try {
    const entry = JSON.parse(new TextDecoder().decode(bytes)) as { inputSchema?: unknown };
    return entry && typeof entry.inputSchema === 'object' && entry.inputSchema !== null ? entry.inputSchema : undefined;
  } catch {
    return undefined;
  }
}

/** A prompt's arguments are strings (the Prompt shape); as a schema, the same form serves them. */
function promptSchema(args: unknown): Record<string, unknown> {
  const list = Array.isArray(args) ? (args as Record<string, unknown>[]).filter((a) => a && typeof a.name === 'string') : [];
  return {
    type: 'object',
    properties: Object.fromEntries(list.map((a) => [a.name as string, { type: 'string', ...(typeof a.description === 'string' ? { description: a.description } : {}) }])),
    required: list.filter((a) => a.required === true).map((a) => a.name as string),
  };
}

export function CallPanel({ client, serverId, serverName, connected, target, onRead }: {
  client: BackendClient;
  serverId: string;
  serverName?: string;
  connected: boolean;
  target: CallTarget;
  onRead: (view: CallView) => void;
}) {
  // A prompt's schema built inline was a new object on every render, and each
  // verdict re-rendered, so validation re-ran without end (R07-1). Keyed on the
  // entry's own values, since `target` is rebuilt whenever the parent renders.
  const toolName = target.kind === 'tool' ? target.tool.name : undefined;
  // R07-7: the captured schema is canonicalized, keys sorted, so a form
  // planned from it lists fields alphabetically. The entry's exact bytes from
  // the list reply keep the server's order; the form is planned from those,
  // and from the captured schema only when the bytes cannot be had.
  // The bytes belong to one capture: keyed on the captured schema as well as
  // the name, so a Refresh that changes the schema fetches them again (R08-4).
  const captured = target.kind === 'tool' ? JSON.stringify(target.tool.inputSchema) : undefined;
  const [rawSchema, setRawSchema] = useState<{ name: string; captured: string; schema: unknown } | null>(null);
  useEffect(() => {
    if (toolName === undefined || captured === undefined) return;
    let stale = false;
    client.request('surface.entry', { serverId, list: 'tools', key: toolName }).then((entry) => {
      if (stale || !entry.found) return;
      const schema = entryInputSchema(entry.bytes);
      if (schema !== undefined) setRawSchema({ name: toolName, captured, schema });
    }, () => undefined);
    return () => { stale = true; };
  }, [client, serverId, toolName, captured]);
  const source = target.kind === 'tool'
    ? (rawSchema !== null && rawSchema.name === toolName && rawSchema.captured === captured ? rawSchema.schema : target.tool.inputSchema)
    : target.kind === 'prompt' ? target.arguments : undefined;
  const schema = useMemo(() => (target.kind === 'tool' ? source : target.kind === 'prompt' ? promptSchema(source) : undefined), [target.kind, source]);
  const uriTemplate = target.kind === 'template' ? target.uriTemplate : undefined;
  const [args, setArgs] = useState<Args>({});
  const [text, setText] = useState(editorText({}));
  const [editorError, setEditorError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [confirm, setConfirm] = useState<ConfirmPrompt | null>(null);
  const [callId, setCallId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [variables, setVariables] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const plan = useMemo(() => (schema === undefined ? null : planForm(schema)), [schema]);

  // Form edits write the editor's text; editor edits that parse write the value.
  const fromForm = (next: Args) => { setArgs(next); setText(editorText(next)); setEditorError(null); };
  const fromEditor = (t: string) => {
    setText(t);
    const parsed = parseEditor(t);
    if ('error' in parsed) return setEditorError(parsed.error);
    setEditorError(null);
    setArgs(parsed.args);
  };

  // Advisory validation, a moment after typing stops.
  const validating = useRef(0);
  useEffect(() => {
    if (schema === undefined) return;
    const mine = ++validating.current;
    const t = setTimeout(() => {
      client.request('calls.validate', { schema, value: args }).then((v) => { if (mine === validating.current) setVerdict(v); }, () => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [client, schema, args]);

  useEffect(() => {
    if (uriTemplate === undefined) return;
    client.request('resources.template', { uriTemplate }).then((t) => setVariables(t.variables), (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, uriTemplate]);

  const send = async (confirmed: boolean) => {
    setBusy(true);
    setError(null);
    try {
      let kind: 'tool' | 'prompt' | 'resource';
      let name: string;
      if (target.kind === 'tool') { kind = 'tool'; name = target.tool.name; }
      else if (target.kind === 'prompt') { kind = 'prompt'; name = target.name; }
      else if (target.kind === 'resource') { kind = 'resource'; name = target.uri; }
      else { kind = 'resource'; name = (await client.request('resources.template', { uriTemplate: target.uriTemplate, values })).uri!; }
      const reply = await client.request('calls.start', {
        serverId, kind, target: name,
        ...(kind === 'resource' ? {} : { args }),
        ...(confirmed ? { confirmed: true } : {}),
      });
      if (reply.started) {
        setConfirm(null);
        setCallId(reply.callId);
      } else {
        setConfirm(reply.confirm);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const verb = target.kind === 'tool' ? 'Call' : target.kind === 'prompt' ? 'Get' : 'Read';
  return (
    <div className="call-panel">
      {target.kind === 'tool' && target.tool.annotations !== undefined && <Hints annotations={target.tool.annotations} />}
      {plan && (
        <div className="call-inputs">
          <div className="call-form">
            <h4>Form</h4>
            {plan.kind === 'editor-only'
              ? <p className="muted">{plan.reason} The JSON editor beside this takes any arguments.</p>
              : plan.fields.length === 0
                ? <p className="muted">{plan.open ? 'No declared arguments. Anything else goes in the JSON editor.' : 'Takes no arguments.'}</p>
                : <Fields fields={plan.fields} args={args} onChange={fromForm} />}
          </div>
          <div className="call-editor">
            <h4>JSON</h4>
            <textarea className="mono" spellCheck={false} value={text} onChange={(e) => fromEditor(e.target.value)} aria-label="Arguments as JSON" />
            {editorError && <p className="error">Not sent until it parses: {editorError}</p>}
          </div>
        </div>
      )}
      {target.kind === 'template' && (
        <div className="call-form">
          <p className="mono">{target.uriTemplate}</p>
          {variables.map((v) => (
            <label key={v} className="field"><span className="mono">{v}</span>
              <input className="mono" value={values[v] ?? ''} onChange={(e) => setValues((s) => ({ ...s, [v]: e.target.value }))} />
            </label>
          ))}
        </div>
      )}
      {verdict && verdict.valid === false && <p className="warn">The arguments do not match the schema: {verdict.message}. They can still be sent; the server decides.</p>}
      {verdict && verdict.valid === null && <p className="muted">The schema could not be used to check the arguments: {verdict.message}</p>}
      {verdict && verdict.valid === true && plan && <p className="ok-line">The arguments match the schema.</p>}
      <div className="actions left">
        <button className="primary" disabled={!connected || busy || editorError !== null} onClick={() => send(false)} title={connected ? undefined : 'Connect the server first'}>{verb}</button>
        {!connected && <span className="muted">Connect the server to {verb.toLowerCase()}.</span>}
      </div>
      {error && <p className="error">{error}</p>}
      {confirm && <ConfirmDialog prompt={confirm} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => send(true)} />}
      {callId !== null && (
        <CallTranscript key={callId} client={client} callId={callId} serverName={serverName} onRead={onRead} onReplay={plan ? (a) => fromForm(a) : undefined} />
      )}
    </div>
  );
}

function Hints({ annotations }: { annotations: unknown }) {
  const rows = annotationRows(annotations);
  if (!rows) return null;
  return (
    <div className="hints">
      <p className="muted">{ANNOTATIONS_LINE}</p>
      <p className="mono">{rows.map(([k, v]) => `${k}: ${v}`).join('  ')}</p>
    </div>
  );
}

function ConfirmDialog({ prompt, busy, onCancel, onConfirm }: { prompt: ConfirmPrompt; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const rows = annotationRows(prompt.annotations);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm the call">
      <div className="modal">
        <h3>Send {prompt.method}?</h3>
        <p>{prompt.why}</p>
        {rows && (<><p className="muted">{ANNOTATIONS_LINE}</p><p className="mono">{rows.map(([k, v]) => `${k}: ${v}`).join('  ')}</p></>)}
        <h4>What will be sent</h4>
        <p className="muted">These params, with the request id and _meta the client adds.</p>
        <pre className="mono json">{JSON.stringify(prompt.params, null, 2)}</pre>
        {prompt.argumentsCheck?.valid === false && <p className="warn">The arguments do not match the tool's schema: {prompt.argumentsCheck.message}</p>}
        <p className="muted">Calls that are not declared read-only ask first. That is the workspace setting "Ask before calls", under Settings.</p>
        <div className="actions">
          <button onClick={onCancel} autoFocus>Do not send</button>
          <button className="primary" disabled={busy} onClick={onConfirm}>Send</button>
        </div>
      </div>
    </div>
  );
}
