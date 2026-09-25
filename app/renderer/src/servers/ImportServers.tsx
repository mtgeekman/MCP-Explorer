// Importing servers from other clients' config files (board 3.3; phase 05
// plan decisions 1-3 and 9-12). Two steps, each one the user takes: pick which
// found files to read, then review every entry before saving. Full command
// lines are shown, and nothing runs until the user connects.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FoundLocation, ReadConfig, ServerRow } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { commandLine } from '../lib/describe';
import { entryKey, hiddenValues, initialState, mergePicked, outcomes, OUT_OF_REACH, plan, redactRaw, toggle, type EntryState, type OnClash, type ReviewState } from '../lib/importReview';

type Step =
  | { kind: 'pick' }
  | { kind: 'review'; files: ReadConfig[]; state: ReviewState }
  | { kind: 'done'; saved: ServerRow[]; skipped: string[] };

export function ImportServers({ client, encrypted, servers, onImported, onClose }: {
  client: BackendClient;
  encrypted: boolean;
  servers: ServerRow[];
  onImported: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [projectRoots, setProjectRoots] = useState<string[]>([]);
  const [locations, setLocations] = useState<FoundLocation[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<Step>({ kind: 'pick' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The list last applied, and the newest listing asked for: a reply to an
  // older request (two folders added quickly) is dropped, not applied last.
  const applied = useRef<FoundLocation[] | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const request = ++latest.current;
    void (async () => {
      try {
        const found = await client.request('import.locations', { projectRoots });
        if (request !== latest.current) return;
        // Found files start ticked; one the user unticked stays unticked when a
        // folder is added. Reading still waits for the button.
        const before = applied.current;
        applied.current = found;
        setPicked((picked) => mergePicked(picked, before, found));
        setLocations(found);
      } catch (e) {
        setError(message(e));
      }
    })();
  }, [client, projectRoots]);

  const addFolder = async () => {
    const folder = await window.mcpxShell?.chooseFolder();
    if (folder && !projectRoots.includes(folder)) setProjectRoots([...projectRoots, folder]);
  };

  const read = async () => {
    setError(null);
    setBusy(true);
    try {
      const files = await client.request('import.read', { locations: (locations ?? []).filter((l) => l.found && picked.has(l.path)) });
      setStep({ kind: 'review', files, state: initialState(files) });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  if (step.kind === 'done') {
    return (
      <div className="editor">
        <h2>Imported {step.saved.length} {step.saved.length === 1 ? 'server' : 'servers'}</h2>
        {step.saved.length > 0 && <p className="hint">Nothing has been started. Each runs when you connect to it.</p>}
        {step.skipped.length > 0 && <p className="hint">Skipped because the name was taken: {step.skipped.join(', ')}.</p>}
        <div className="actions"><button className="primary" onClick={onClose}>Done</button></div>
      </div>
    );
  }

  if (step.kind === 'review') {
    return <Review files={step.files} state={step.state} encrypted={encrypted} servers={servers} busy={busy} error={error}
      onChange={(state) => setStep({ ...step, state })}
      onBack={() => { setError(null); setStep({ kind: 'pick' }); }}
      onImport={async (p) => {
        setError(null);
        setBusy(true);
        try {
          const saved = await client.request('import.save', { servers: p.choices });
          await onImported();
          setStep({ kind: 'done', saved, skipped: p.skipped });
        } catch (e) {
          setError(message(e));
        } finally {
          setBusy(false);
        }
      }} />;
  }

  const found = (locations ?? []).filter((l) => l.found);
  const unreadable = (locations ?? []).filter((l) => l.unreadable);
  const missing = (locations ?? []).filter((l) => !l.found && !l.unreadable);
  return (
    <div className="editor import">
      <h2>Import servers</h2>
      <p className="hint">Choose which config files to read. Reading a file runs nothing; you review every server before it is added.</p>
      {!locations && !error && <p className="hint">Looking for config files</p>}
      {locations && found.length === 0 && <p className="hint">No config files were found in the usual places.</p>}
      <ul className="picker">
        {found.map((l) => (
          <li key={l.path}>
            <label className="choice">
              <input type="checkbox" checked={picked.has(l.path)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(l.path); else n.delete(l.path); return n; })} />
              <span><strong>{l.label}</strong><br /><small className="mono">{l.path}</small></span>
            </label>
          </li>
        ))}
      </ul>
      {unreadable.map((l) => <p key={l.path} className="error">{l.label}: {l.path} could not be checked ({l.unreadable}).</p>)}
      <div className="actions start">
        <button type="button" onClick={() => void addFolder()} disabled={!window.mcpxShell}>Add a project folder</button>
      </div>
      {projectRoots.length > 0 && <p className="hint">Project folders: {projectRoots.join(', ')}</p>}
      {missing.length > 0 && (
        <details className="looked-in">
          <summary>Also looked in {missing.length} places with no file</summary>
          <ul>{missing.map((l) => <li key={l.path}><span>{l.label}</span> <small className="mono">{l.path}</small></li>)}</ul>
        </details>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={busy || picked.size === 0} onClick={() => void read()}>Read {picked.size} {picked.size === 1 ? 'file' : 'files'}</button>
      </div>
    </div>
  );
}

function Review({ files, state, encrypted, servers, busy, error, onChange, onBack, onImport }: {
  files: ReadConfig[];
  state: ReviewState;
  encrypted: boolean;
  servers: ServerRow[];
  busy: boolean;
  error: string | null;
  onChange: (s: ReviewState) => void;
  onBack: () => void;
  onImport: (p: ReturnType<typeof plan>) => void;
}) {
  const result = useMemo(() => plan(files, state, servers), [files, state, servers]);
  const decided = useMemo(() => outcomes(files, state, servers), [files, state, servers]);
  const set = (key: string, patch: Partial<EntryState>) => onChange({ ...state, [key]: { ...state[key], ...patch } });
  const anySecrets = result.choices.some((c) => c.secrets.env.length + c.secrets.headers.length > 0);

  return (
    <div className="editor import">
      <h2>Review servers to import</h2>
      <p className="hint">Nothing runs until you connect. Check each command before you keep it.</p>
      {files.map((f, i) => (
        <section key={f.location.path} className="import-file">
          <h3>{f.location.label}</h3>
          <p className="hint mono">{f.location.path}</p>
          {f.problems.map((p) => <p key={p} className="error">{p}</p>)}
          {f.entries.length === 0 && f.problems.length === 0 && <p className="hint">No servers in this file.</p>}
          {f.entries.map((e, j) => {
            const key = entryKey(i, j);
            const s = state[key];
            const o = decided.get(key);
            return (
              <div key={key} className={`import-entry ${e.disabled ? 'disabled' : ''}`}>
                <div className="import-entry-head">
                  <label className="attest">
                    <input type="checkbox" disabled={!e.server} checked={Boolean(s?.keep)} onChange={(ev) => set(key, { keep: ev.target.checked })} />
                    <strong>{e.name}</strong>
                  </label>
                  <small className="hint">{e.location}{e.projectRoot ? `, project ${e.projectRoot}` : ''}</small>
                </div>
                {e.disabled && <p className="error">Cannot be imported: {e.disabled}</p>}
                {e.server && s && (
                  <>
                    <div className="will-run">
                      <span>{e.server.transport === 'stdio' ? 'Connecting will run' : `Connecting will open (${e.server.transport})`}</span>
                      <code className="mono">{e.server.transport === 'stdio' ? commandLine(e.server.command!, e.server.args) : e.server.url}</code>
                      {e.server.cwd && <small>in {e.server.cwd}</small>}
                    </div>
                    {s.keep && (
                      <label className="field"><span>Name</span><input value={s.name} onChange={(ev) => set(key, { name: ev.target.value })} /></label>
                    )}
                    {s.keep && o?.clash && (
                      <label className="field">
                        <span>{o.clash.existing ? `A server named ${s.name.trim()} already exists` : `Another server in this import is named ${s.name.trim()}`}</span>
                        <select value={s.onClash} onChange={(ev) => set(key, { onClash: ev.target.value as OnClash })}>
                          <option value="skip">Skip this one</option>
                          <option value="rename">Rename this one</option>
                          {o.clash.existing && !o.clash.entry && <option value="replace">Replace the saved server</option>}
                        </select>
                      </label>
                    )}
                    {s.keep && o?.problem && <p className="error">{o.problem}</p>}
                    <Values title={e.server.transport === 'stdio' ? 'Environment' : 'Headers'} values={e.server.transport === 'stdio' ? e.server.env : e.server.headers}
                      marked={e.server.transport === 'stdio' ? s.secretEnv : s.secretHeaders}
                      onMark={(name, on) => (e.server!.transport === 'stdio' ? set(key, { secretEnv: toggle(s.secretEnv, name, on) }) : set(key, { secretHeaders: toggle(s.secretHeaders, name, on) }))} />
                    {e.notes.map((n) => <p key={n} className="hint">{n}</p>)}
                  </>
                )}
                {e.dropped.length > 0 && (
                  <div className="hint">Left out:<ul>{e.dropped.map((d) => <li key={d}>{d}</li>)}</ul></div>
                )}
                <details><summary>As written in the file</summary><pre className="mono raw-entry">{redactRaw(e.raw, hiddenValues(e, s))}</pre></details>
              </div>
            );
          })}
        </section>
      ))}
      <p className="hint">
        {encrypted
          ? 'Values marked secret are stored encrypted in this workspace and never shown again.'
          : 'This workspace is not encrypted: for values marked secret only the name is kept, and you enter the value each session. The value in the file is not copied.'}
        {anySecrets ? '' : ' No values are marked secret.'}
      </p>
      <p className="hint">Not in any file, so not imported: {OUT_OF_REACH.join('; ')}.</p>
      {result.problems.map((p) => <p key={p} className="error">{p}</p>)}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="button" onClick={onBack}>Back</button>
        <button type="button" className="primary" disabled={busy || result.problems.length > 0 || result.choices.length === 0} onClick={() => onImport(result)}>
          Import {result.choices.length} {result.choices.length === 1 ? 'server' : 'servers'}
        </button>
      </div>
    </div>
  );
}

function Values({ title, values, marked, onMark }: { title: string; values: Record<string, string>; marked: string[]; onMark: (name: string, on: boolean) => void }) {
  const names = Object.keys(values);
  if (names.length === 0) return null;
  return (
    <table className="import-values">
      <thead><tr><th>{title}</th><th>Value</th><th>Secret</th></tr></thead>
      <tbody>
        {names.map((n) => (
          <tr key={n}>
            <td className="mono">{n}</td>
            <td className="mono">{marked.includes(n) ? '(hidden)' : values[n]}</td>
            <td><input type="checkbox" aria-label={`${n} is a secret`} checked={marked.includes(n)} onChange={(e) => onMark(n, e.target.checked)} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
