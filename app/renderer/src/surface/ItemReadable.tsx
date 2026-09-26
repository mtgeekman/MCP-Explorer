// One surface entry as a person reads it (board 5.1A's pane): parameters,
// arguments, annotations with the line that says they are not trusted, and a
// Fields list where "none sent" and "not on this revision" stay apart (5.4).
import { Fragment } from 'react';
import { JsonView } from '../log/JsonView';
import type { SelectedItem } from './SurfacePanel';
import { ANNOTATIONS_LINE, FIELDS, ITEM_KIND, annotationRows, fieldState, parameters, promptArguments } from '../lib/surface';

export function ItemReadable({ selected }: { selected: SelectedItem }) {
  const { item, list, key, revision } = selected;
  const kind = ITEM_KIND[list];
  const description = typeof item.description === 'string' ? item.description : undefined;
  return (
    <div className="readable-body">
      <h4 className="mono">{key}</h4>
      {typeof item.title === 'string' && <p>{item.title}</p>}
      {description !== undefined && <p className="description">{description}</p>}

      {kind === 'tool' && <ToolParts item={item} revision={revision} />}
      {kind === 'prompt' && <PromptArguments args={item.arguments} />}

      <h4>Fields</h4>
      <ul className="params item-fields">
        {FIELDS[kind].map((field) => {
          const s = fieldState(kind, field, item, revision);
          return (
            <li key={field} className="param">
              <div className="param-head"><span className="mono param-name">{field}</span></div>
              {s.kind !== 'value'
                ? <p className="param-desc muted">{s.kind === 'none-sent' ? 'None sent' : s.label}</p>
                : typeof s.value === 'string' ? <p className="param-desc">{s.value}</p> : <JsonView value={s.value} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ToolParts({ item, revision }: { item: Record<string, unknown>; revision: string }) {
  const params = parameters(item.inputSchema);
  const annotations = fieldState('tool', 'annotations', item, revision);
  const rows = annotations.kind === 'value' ? annotationRows(annotations.value) : undefined;
  return (
    <>
      <h4>Parameters</h4>
      {params === undefined && <p className="muted">The input schema has no properties object to list; the raw view shows it as sent.</p>}
      {params?.length === 0 && <p className="muted">None.</p>}
      {params && params.length > 0 && (
        <ParamList items={params.map((p) => ({ name: p.name, required: p.required, type: p.type, description: p.description }))} />
      )}
      <h4>Annotations</h4>
      <p className="muted">{ANNOTATIONS_LINE}</p>
      {annotations.kind === 'not-on-revision' && <p className="muted">{annotations.label}</p>}
      {annotations.kind === 'none-sent' && <p className="muted">None sent.</p>}
      {annotations.kind === 'value' && (rows
        ? <dl className="facts">{rows.map(([k, v]) => <Fragment key={k}><dt className="mono">{k}</dt><dd className="mono">{v}</dd></Fragment>)}</dl>
        : <p className="mono">{JSON.stringify(annotations.value)}</p>)}
    </>
  );
}

function PromptArguments({ args }: { args: unknown }) {
  const list = promptArguments(args);
  return (
    <>
      <h4>Arguments</h4>
      {list === undefined && <p className="muted">Not a list of named arguments; the raw view shows it as sent.</p>}
      {list?.length === 0 && <p className="muted">None.</p>}
      {list && list.length > 0 && (
        <ParamList items={list.map((a) => ({ name: a.name, required: a.required, description: a.description }))} />
      )}
      <p className="muted">Getting a prompt sends nothing to a model.</p>
    </>
  );
}

/** A field's value in one line: strings as they are, anything else as compact JSON, long ones cut with a count. */
/**
 * A tool's parameters or a prompt's arguments: the name and type on one
 * line, the description under them. Stacked rather than a table, because in
 * a narrow pane a table squeezes its short columns to a letter wide.
 */
function ParamList({ items }: { items: { name: string; required: boolean; type?: string; description?: string }[] }) {
  return (
    <ul className="params">
      {items.map((p) => (
        <li key={p.name} className="param">
          <div className="param-head">
            <span className="mono param-name">{p.name}{p.required ? ' *' : ''}</span>
            {p.type !== undefined && <span className="mono param-type">{p.type}</span>}
          </div>
          {p.description && <p className="param-desc">{p.description}</p>}
        </li>
      ))}
    </ul>
  );
}
