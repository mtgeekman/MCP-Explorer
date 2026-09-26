// A form's fields over one arguments value (D9): the tool call view and a
// form elicitation both use them. A field the form cannot render is the JSON
// editor's, and the editor beside the form can always write what the schema
// allows.
import { useEffect, useRef, useState } from 'react';
import { formatInput, getAt, isInputError, parseInput, setAt, type Args, type Field } from '../lib/schemaForm';

export function Fields({ fields, args, onChange }: { fields: Field[]; args: Args; onChange: (a: Args) => void }) {
  return <>{fields.map((f) => <FieldInput key={f.path.join('.')} field={f} args={args} onChange={onChange} />)}</>;
}

function FieldInput({ field: f, args, onChange }: { field: Field; args: Args; onChange: (a: Args) => void }) {
  const current = getAt(args, f.path);
  const shown = formatInput(f, current);
  // What the user typed stays in the input ("1." on the way to "1.5", a list's
  // trailing newline) until the value changes from elsewhere: the JSON editor.
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const committed = useRef<string | undefined>(JSON.stringify(current));
  const now = JSON.stringify(current);
  useEffect(() => {
    if (now !== committed.current) { committed.current = now; setDraft(null); setProblem(null); }
  }, [now]);
  const label = (
    <span>
      <span className="mono">{f.label}</span>{f.required && <span className="required" title="Required"> *</span>}
      {f.title && <small> {f.title}</small>}
    </span>
  );
  const hint = f.description ? <small className="muted">{f.description}</small> : null;

  if (f.kind === 'object') {
    return (
      <fieldset className="field-group"><legend>{label}</legend>{hint}
        <Fields fields={f.fields} args={args} onChange={onChange} />
      </fieldset>
    );
  }
  if (f.kind === 'editor') {
    return (
      <div className="field">{label}{hint}
        <small className="muted">In the JSON editor: {f.reason}</small>
        {current !== undefined && <code className="mono">{JSON.stringify(current)}</code>}
      </div>
    );
  }
  if (shown === null) {
    return <div className="field">{label}<small className="warn">The value in the JSON editor is not a {f.kind}; edit it there.</small></div>;
  }
  const commit = (t: string) => {
    const v = parseInput(f, t);
    setDraft(t);
    if (isInputError(v)) { setProblem(v.error); return; }
    setProblem(null);
    committed.current = JSON.stringify(v);
    onChange(setAt(args, f.path, v));
  };
  const value = draft ?? shown;
  let input;
  if (f.kind === 'boolean' || f.kind === 'enum') {
    const options = f.kind === 'boolean' ? [true, false] : f.options;
    input = (
      <select value={value} onChange={(e) => commit(e.target.value)}>
        <option value="">{f.required ? 'Choose' : 'Not set'}</option>
        {options.map((o) => <option key={String(o)} value={f.kind === 'boolean' ? String(o) : JSON.stringify(o)}>{String(o)}</option>)}
      </select>
    );
  } else if (f.kind === 'const') {
    input = (
      <label className="inline"><input type="checkbox" checked={current !== undefined} onChange={(e) => commit(e.target.checked ? JSON.stringify(f.value) : '')} /> <code className="mono">{JSON.stringify(f.value)}</code></label>
    );
  } else if (f.kind === 'array') {
    input = <textarea className="mono" rows={3} value={value} placeholder="One per line" onChange={(e) => commit(e.target.value)} />;
  } else {
    input = <input className="mono" value={value} placeholder={f.kind === 'string' && f.format ? f.format : f.kind !== 'string' ? f.kind : ''} onChange={(e) => commit(e.target.value)} />;
  }
  return (
    <label className="field">{label}{hint}{input}
      {'default' in f && f.default !== undefined && current === undefined && <small className="muted">The server's default, {JSON.stringify(f.default)}, is not filled in: unset fields are not sent.</small>}
      {problem && <small className="error">{problem}</small>}
    </label>
  );
}

