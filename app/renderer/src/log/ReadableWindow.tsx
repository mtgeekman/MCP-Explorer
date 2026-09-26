// The readable pane in its own window (board 1A). It has its own port to the
// backend and reads what the main window has selected: a wire log unit, or a
// surface entry from that server's latest capture.
import { useEffect, useState } from 'react';
import type { BackendClient } from '../lib/client';
import { entryKey } from '../lib/surface';
import { ReadableBody, type ReadableContent } from './ReadablePane';

export function ReadableWindow({ client }: { client: BackendClient }) {
  const [content, setContent] = useState<ReadableContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // After a backend restart this window gets a new client; the old one's
    // listener is removed so only the live port is asked.
    return window.mcpxShell?.onReadableSelect((selection) => {
      setError(null);
      if (!selection) return setContent(null);
      const failed = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
      if ('callId' in selection) {
        client.request('calls.get', selection).then((view) => (view ? setContent({ kind: 'call', view }) : setError('That call is no longer in the history.')), failed);
        return;
      }
      if ('id' in selection) {
        client.request('log.get', selection).then((unit) => setContent(unit ? { kind: 'unit', unit } : null), failed);
        return;
      }
      client.request('surface.get', { serverId: selection.serverId }).then((view) => {
        const surface = (view.partial ?? view.capture)?.surface;
        const item = (surface?.[selection.list] as unknown as Record<string, unknown>[] | undefined)?.find((i) => entryKey(selection.list, i) === selection.key);
        if (!surface || !item) return setError('That entry is no longer in the latest capture.');
        setContent({ kind: 'item', item: { serverId: selection.serverId, list: selection.list, key: selection.key, item, revision: surface.revision } });
      }, failed);
    });
  }, [client]);
  return (
    <div className="readable-window">
      <div className="pane-head"><span>Readable</span></div>
      {error ? <p className="error pad">{error}</p> : <ReadableBody content={content} />}
    </div>
  );
}
