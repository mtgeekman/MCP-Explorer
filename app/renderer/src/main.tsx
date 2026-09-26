import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles.css';
import { App } from './App';
import { ReadableWindow } from './log/ReadableWindow';
import { BackendClient } from './lib/client';
import type { EntryList } from '../../../packages/backend/dist/index.js';

/** What the popped-out pane is told to show: a wire log unit, a surface entry, or a call's result. */
type ReadableSelection = { id: number; reserialized: boolean } | { serverId: string; list: EntryList; key: string } | { callId: number } | null;

/** The shell's preload bridge (app/preload/preload.cts). */
declare global {
  interface Window {
    mcpxShell?: {
      onBackendExit(listener: (code: number) => void): void;
      restartBackend(): void;
      popOutReadable(): void;
      selectReadable(selection: ReadableSelection): void;
      onReadableSelect(listener: (selection: ReadableSelection) => void): () => void;
      onReadableClosed(listener: () => void): void;
      /** A folder the user chose in the system dialog, or null if they cancelled. */
      chooseFolder(): Promise<string | null>;
    };
  }
}

const root = createRoot(document.getElementById('root')!);

// The main process posts a fresh port to the backend each time the page loads,
// and again after a backend restart.
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data !== 'mcpx:backend-port' || !e.ports[0]) return;
  const client = new BackendClient(e.ports[0]);
  root.render(location.hash === '#readable' ? <ReadableWindow client={client} /> : <App key={Date.now()} client={client} />);
});

root.render(<div className="boot">Starting the backend</div>);
