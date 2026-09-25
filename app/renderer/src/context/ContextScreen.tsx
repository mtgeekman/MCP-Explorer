// The workspace context preview (spec D3; phase 06 decisions 1, 2 and 4):
// every server's latest captured surface as the block a client hands a model,
// what it costs, the worst offenders, and the tool names that collide. The
// block is the main view and shown as its exact text; nothing here asks a
// server for anything.
import { useEffect, useMemo, useState } from 'react';
import type { ContextView } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { worstOffenders } from '../lib/contextView';
import { RawViewer } from '../log/RawViewer';

const encoder = new TextEncoder();

export function ContextScreen({ client, onClose }: { client: BackendClient; onClose: () => void }) {
  // Which servers are left out lives for this screen only; it is not saved.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [view, setView] = useState<ContextView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    const load = () => client.request('context.get', { excluded: [...excluded] }).then(
      (v) => { if (!stale) { setView(v); setError(null); } },
      (e: unknown) => { if (!stale) setError(e instanceof Error ? e.message : String(e)); },
    );
    void load();
    const off = client.on((name) => { if (name === 'surface.changed') void load(); });
    return () => { stale = true; off(); };
  }, [client, excluded]);

  const bytes = useMemo(() => (view ? encoder.encode(view.text) : null), [view]);
  const names = useMemo(() => new Map(view?.servers.map((s) => [s.id, s.name]) ?? []), [view]);
  const toggle = (id: string) => setExcluded((ex) => {
    const next = new Set(ex);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section className="detail context">
      <header className="detail-head">
        <div>
          <h2>Context preview</h2>
          <p className="hint">What a client hands a model from this workspace: each server's instructions, and every tool as the Anthropic Messages API takes it. Prompts and resources are offered to the user, not the model, so they are not in it.</p>
        </div>
        <div className="actions"><button onClick={onClose}>Close</button></div>
      </header>
      {error && <p className="error">{error}</p>}
      {view && (
        <>
          <p className="hint tokenizer-label">{view.cost.tokenizer.label}. Each server's latest capture is used, connected or not; the heading lines around the instructions are this app's.</p>
          <table className="fields context-servers">
            <thead><tr><th>Include</th><th>Server</th><th>Captured</th><th>Instructions</th><th>Tools</th><th>Total</th></tr></thead>
            <tbody>
              {view.servers.map((s) => {
                const cost = view.cost.servers.find((c) => c.serverId === s.id);
                return (
                  <tr key={s.id}>
                    {/* The box follows the choice at once; the numbers follow the backend's answer. */}
                    <td><input type="checkbox" aria-label={`Include ${s.name}`} checked={!excluded.has(s.id)} onChange={() => toggle(s.id)} /></td>
                    <td>{s.name}</td>
                    <td className="muted">{s.capturedAt === null ? 'Never captured; adds nothing' : `${new Date(s.capturedAt).toLocaleString()}, ${s.revision}`}</td>
                    <td className="num">{cost ? cost.instructions.toLocaleString() : ''}</td>
                    <td className="num">{cost ? cost.tools.toLocaleString() : ''}</td>
                    <td className="num">{cost ? cost.total.toLocaleString() : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="context-total"><strong>{view.cost.total.toLocaleString()} tokens</strong>{view.cost.shared > 0 && <span className="muted"> including {view.cost.shared} for the instructions heading</span>}</p>

          <h3>Tool names more than one server lists</h3>
          {view.cost.collisions.length === 0
            ? <p className="muted">None. Every tool name in the block is unique.</p>
            : (
              <ul className="collisions">
                {view.cost.collisions.map((c) => (
                  <li key={c.name}><code className="mono">{c.name}</code> from {c.serverIds.map((id) => names.get(id) ?? id).join(', ')}. An agent sees one namespace, so it cannot tell these apart.</li>
                ))}
              </ul>
            )}

          <h3>Most expensive tools</h3>
          {view.cost.tools.length === 0 ? <p className="muted">No tools.</p> : (
            <table className="fields">
              <tbody>
                {worstOffenders(view.cost, 10).map((t) => (
                  <tr key={`${t.serverId}:${t.name}`}>
                    <td className="mono">{t.name}</td>
                    <td className="muted">{names.get(t.serverId) ?? t.serverId}</td>
                    <td className="num">{t.tokens.toLocaleString()}</td>
                    <td className="muted num">{t.share}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>The block</h3>
          {bytes && <RawViewer bytes={bytes} height={420} />}
        </>
      )}
    </section>
  );
}
