// The workspace's settings: calls ("Ask before calls", board 6.2B; the MRTR
// soft cap, D21) and history (the results opt-out, D30; retention, D24).
// Deleting and compacting history are buttons the user presses, never side
// effects of saving (P2).
import { useCallback, useEffect, useState } from 'react';
import type { HistorySize, PurgeResult, WorkspaceSettings } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { describePurge, formatBytes, parseFields, toFields, type SettingsFields } from '../lib/settings';

type Purge =
  | { step: 'idle' }
  | { step: 'previewing' }
  | { step: 'confirm'; preview: PurgeResult }
  | { step: 'purging' }
  | { step: 'done'; result: PurgeResult };

export function Settings({ client, workspaceName, onClose }: { client: BackendClient; workspaceName: string; onClose: () => void }) {
  const [current, setCurrent] = useState<WorkspaceSettings | null>(null);
  const [fields, setFields] = useState<SettingsFields | null>(null);
  const [size, setSize] = useState<HistorySize | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [purge, setPurge] = useState<Purge>({ step: 'idle' });
  const [compacting, setCompacting] = useState(false);
  const [compacted, setCompacted] = useState<{ before: number; after: number } | null>(null);

  const refreshSize = useCallback(async () => setSize(await client.request('history.size', {})), [client]);

  useEffect(() => {
    void (async () => {
      try {
        const s = await client.request('settings.get', {});
        setCurrent(s);
        setFields(toFields(s));
        await refreshSize();
      } catch (e) {
        setError(message(e));
      }
    })();
  }, [client, refreshSize]);

  if (!current || !fields) return <div className="editor">{error ? <p className="error">{error}</p> : 'Loading'}</div>;

  const { changes, problems } = parseFields(fields, current);
  const dirty = Object.keys(changes).length > 0;
  const set = (patch: Partial<SettingsFields>) => { setFields({ ...fields, ...patch }); setSaved(false); };

  const save = async () => {
    setError(null);
    try {
      const next = await client.request('settings.update', { changes });
      setCurrent(next);
      setFields(toFields(next));
      setSaved(true);
      // A new limit changes what "Purge now" would do.
      if (purge.step === 'confirm') setPurge({ step: 'idle' });
    } catch (e) {
      setError(message(e));
    }
  };

  const previewPurge = async () => {
    setError(null);
    setPurge({ step: 'previewing' });
    try {
      setPurge({ step: 'confirm', preview: await client.request('history.previewPurge', {}) });
    } catch (e) {
      setPurge({ step: 'idle' });
      setError(message(e));
    }
  };

  const runPurge = async () => {
    setError(null);
    setPurge({ step: 'purging' });
    try {
      setPurge({ step: 'done', result: await client.request('history.purge', {}) });
      await refreshSize();
    } catch (e) {
      setPurge({ step: 'idle' });
      setError(message(e));
    }
  };

  const runCompact = async () => {
    setError(null);
    setCompacting(true);
    try {
      setCompacted(await client.request('history.compact', {}));
      await refreshSize();
    } catch (e) {
      setError(message(e));
    } finally {
      setCompacting(false);
    }
  };

  return (
    <form className="editor settings" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2>Settings for {workspaceName}</h2>
      <p className="hint">These apply to this workspace only.</p>

      <fieldset className="secrets">
        <legend>Calls</legend>
        <label className="attest">
          <input type="checkbox" checked={fields.askBeforeCalls} onChange={(e) => set({ askBeforeCalls: e.target.checked })} />
          <span>Ask before calls</span>
        </label>
        <p className="hint">
          {fields.askBeforeCalls
            ? 'A call to a tool the server has not marked read-only waits for you to confirm it.'
            : 'Calls run as soon as you press Call, including ones that may change or delete things.'}
          {' '}The read-only mark comes from the server and is not checked.
        </p>
        <label className="field">
          <span>Rounds before pausing a call</span>
          <input inputMode="numeric" value={fields.mrtrSoftCap} onChange={(e) => set({ mrtrSoftCap: e.target.value })} />
        </label>
        <p className="hint">A server can keep asking for more input on the same call. After this many rounds the call pauses and asks whether to go on.</p>
      </fieldset>

      <fieldset className="secrets">
        <legend>History</legend>
        <label className="attest">
          <input type="checkbox" checked={fields.persistResults} onChange={(e) => set({ persistResults: e.target.checked })} />
          <span>Keep call results</span>
        </label>
        <p className="hint">
          {fields.persistResults
            ? 'Results of tool calls, prompts and resource reads are stored with their frames.'
            : 'The log still shows that each response happened and when; its body is not stored.'}
          {current.persistResults && !fields.persistResults && ' Results already stored stay until retention removes them.'}
        </p>
        <div className="row">
          <label className="field">
            <span>Largest history, MB</span>
            <input inputMode="numeric" value={fields.retentionMaxMb} onChange={(e) => set({ retentionMaxMb: e.target.value })} />
          </label>
          <label className="field">
            <span>Oldest history, days</span>
            <input inputMode="numeric" value={fields.retentionMaxAgeDays} onChange={(e) => set({ retentionMaxAgeDays: e.target.value })} />
          </label>
        </div>
        <p className="hint">
          Whichever limit is reached first, the oldest calls go, whole. Limits apply when the workspace opens and when a call finishes.
          Surface snapshots are never removed.
        </p>
        {size && (
          <p className="hint">
            History uses {formatBytes(size.usedBytes)}; the file is {formatBytes(size.fileBytes)}.
            {' '}The file does not shrink when history is removed until you compact it.
          </p>
        )}
      </fieldset>

      {problems.map((p) => <p key={p} className="error">{p}</p>)}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        {saved && !dirty && <span className="hint">Saved.</span>}
        <button type="button" onClick={onClose}>Close</button>
        <button type="submit" className="primary" disabled={!dirty || problems.length > 0}>Save</button>
      </div>

      <fieldset className="secrets">
        <legend>Clean up now</legend>
        <div className="actions start">
          <button type="button" disabled={dirty || purge.step === 'previewing' || purge.step === 'purging'} onClick={() => void previewPurge()}>Purge now</button>
          <button type="button" disabled={compacting} onClick={() => void runCompact()}>{compacting ? 'Compacting' : 'Compact'}</button>
        </div>
        {dirty && <p className="hint">Save or undo your changes first: a purge uses the saved limits.</p>}
        {purge.step === 'confirm' && (
          describePurge(purge.preview).length === 0
            ? <p className="hint">Nothing is over the saved limits. Nothing would be removed.</p>
            : (
              <div className="confirm-bar">
                <span>
                  This removes {describePurge(purge.preview).join('; ')}.
                  {purge.preview.overCapWithNothingToPurge && ' Snapshots alone would still be over the size limit.'}
                </span>
                <button type="button" onClick={() => setPurge({ step: 'idle' })}>Cancel</button>
                <button type="button" className="danger" onClick={() => void runPurge()}>Remove</button>
              </div>
            )
        )}
        {purge.step === 'done' && (
          <p className="hint">
            {describePurge(purge.result).length ? `Removed ${describePurge(purge.result).join('; ')}.` : 'Nothing was removed.'}
          </p>
        )}
        {compacted && <p className="hint">Compacted: the file went from {formatBytes(compacted.before)} to {formatBytes(compacted.after)}.</p>}
        <p className="hint">Compact rewrites the whole file and can take a while on a large history.</p>
      </fieldset>
    </form>
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
