// Two versions compared (board 7.1B): opens on "What the model sees", the
// line diff of the context block for this server; "By item" and "Raw
// snapshots" are one click over. The token delta sits above all three.
import { useEffect, useMemo, useState } from 'react';
import type { TextComparison, VersionComparison } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { latestOnly } from '../lib/latest';
import { fieldRows, hunkHeader, instructionsTokenCells, segments, tokenLine, toolTokenCells } from '../lib/versions';

type Tab = 'model' | 'items' | 'raw';
const TABS: [Tab, string][] = [['model', 'What the model sees'], ['items', 'By item'], ['raw', 'Raw snapshots']];

export function VersionDiff({ client, serverId, before, after }: { client: BackendClient; serverId: string; before: number; after: number }) {
  const [comparison, setComparison] = useState<VersionComparison | null>(null);
  const [tab, setTab] = useState<Tab>('model');
  const [error, setError] = useState<string | null>(null);
  const latest = useMemo(() => latestOnly(), []);

  useEffect(() => {
    setComparison(null);
    void latest(client.request('versions.diff', { serverId, before, after }), (c) => { setComparison(c); setError(null); },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, serverId, before, after, latest]);

  if (error) return <p className="error">{error}</p>;
  if (!comparison) return <p className="muted">Comparing</p>;
  const { tokens } = comparison;
  const instructionsRow = instructionsTokenCells(tokens);
  // Keyed apart from the tools: a server may name a tool "(instructions)".
  const costRows = [
    ...(instructionsRow ? [{ key: 'instructions', cells: instructionsRow, instructions: true }] : []),
    ...tokens.tools.map((t) => ({ key: `tool:${t.name}`, cells: toolTokenCells(t), instructions: false })),
  ];

  return (
    <div className="version-diff">
      <p className="token-line" title={tokens.tokenizer.label}>{tokenLine(tokens)}</p>
      <div className="tabs small" role="tablist">
        {TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'tab on' : 'tab'} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === 'model' && (
        <>
          <TextDiffView text={comparison.model} same="Nothing the model sees changed." />
          {costRows.length > 0 && (
            <table className="calls token-table"><tbody>
              {costRows.map(({ key, cells: [name, what, delta], instructions }) => (
                <tr key={key}>
                  <td className={instructions ? 'muted' : 'mono'}>{instructions ? 'Instructions' : name}</td>
                  <td className="muted">{what}</td><td className="mono">{delta}</td>
                </tr>
              ))}
            </tbody></table>
          )}
          <p className="muted">The block this server adds to a model request, as the context preview builds it. Counts are {tokens.tokenizer.label}.</p>
        </>
      )}
      {tab === 'items' && <ItemsView comparison={comparison} />}
      {tab === 'raw' && (
        <>
          <p className="muted">Each snapshot as stored: its canonical JSON, allowlisted fields only, keys sorted. Not wire bytes; those are in the wire log.</p>
          <TextDiffView text={comparison.raw} same="The stored snapshots are identical." />
        </>
      )}
    </div>
  );
}

function ItemsView({ comparison }: { comparison: VersionComparison }) {
  const rows = fieldRows(comparison.structured);
  if (rows.length === 0) return <p className="muted">No item, field, identity or revision differs.</p>;
  return (
    <table className="calls field-table">
      <thead><tr><th>What</th><th>Item</th><th>Field</th><th>Before</th><th>After</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} data-kind={r.kind}>
            <td>{r.group} <span className={`change ${r.kind}`}>{r.kind}</span></td>
            <td className="mono">{r.key}</td>
            <td className="mono">{r.path ?? ''}</td>
            <td className="mono value">{r.before ?? ''}</td>
            <td className="mono value">{r.after ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TextDiffView({ text, same }: { text: TextComparison; same: string }) {
  const { diff } = text;
  if (!diff.complete) {
    return (
      <>
        <p className="warn">Too many lines differ to diff line by line; both versions are shown whole.</p>
        <div className="diff-whole">
          <pre className="mono">{text.before}</pre>
          <pre className="mono">{text.after}</pre>
        </div>
      </>
    );
  }
  if (diff.hunks.length === 0) return <p className="muted">{same}</p>;
  return (
    <div className="text-diff mono">
      <p className="muted">{diff.removed} removed, {diff.added} added</p>
      {diff.hunks.map((h, i) => (
        <div key={i} className="hunk">
          <div className="hunk-head">{hunkHeader(h)}</div>
          {h.lines.map((l, j) => (
            <div key={j} className={`diff-line ${l.op}`}>
              <span className="ln">{l.before ?? ''}</span>
              <span className="ln">{l.after ?? ''}</span>
              <span className="sign">{l.op === 'added' ? '+' : l.op === 'removed' ? '-' : ' '}</span>
              <span className="code">{segments(l).map((s, k) => (s.marked ? <mark key={k}>{s.text}</mark> : <span key={k}>{s.text}</span>))}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
