// One surface entry as a person reads it (board 5.1A's pane): parameters,
// arguments, annotations with the line that says they are not trusted, and a
// Fields table where "none sent" and "not on this revision" stay apart (5.4).
import { Fragment } from 'react';
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
      <table className="fields"><tbody>
        {FIELDS[kind].map((field) => {
          const s = fieldState(kind, field, item, revision);
          return (
            <tr key={field}>
              <td className="mono">{field}</td>
              <td className={s.kind === 'value' ? 'mono' : 'muted'}>
                {s.kind === 'value' ? summarize(s.value) : s.kind === 'none-sent' ? 'None sent' : s.label}
              </td>
            </tr>
          );
        })}
      </tbody></table>
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
        <table className="fields"><tbody>
          {params.map((p) => (
            <tr key={p.name}>
              <td className="mono">{p.name}{p.required ? ' *' : ''}</td>
              <td className="mono">{p.type}</td>
              <td>{p.description}</td>
            </tr>
          ))}
        </tbody></table>
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
        <table className="fields"><tbody>
          {list.map((a) => <tr key={a.name}><td className="mono">{a.name}{a.required ? ' *' : ''}</td><td>{a.description}</td></tr>)}
        </tbody></table>
      )}
      <p className="muted">Getting a prompt sends nothing to a model.</p>
    </>
  );
}

/** A field's value in one line: strings as they are, anything else as compact JSON, long ones cut with a count. */
function summarize(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}... (${text.length.toLocaleString()} characters)` : text;
}
