// The readable pane in its own window (board 1A). It has its own port to the
// backend and reads the unit the main window has selected.
import { useEffect, useState } from 'react';
import type { LogUnit } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { ReadableBody } from './ReadablePane';

export function ReadableWindow({ client }: { client: BackendClient }) {
  const [unit, setUnit] = useState<LogUnit | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    window.mcpxShell?.onReadableSelect((selection) => {
      setError(null);
      if (!selection) return setUnit(null);
      client.request('log.get', selection).then(setUnit, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    });
  }, [client]);
  return (
    <div className="readable-window">
      <div className="pane-head"><span>Readable</span></div>
      {error ? <p className="error pad">{error}</p> : <ReadableBody unit={unit} />}
    </div>
  );
}
