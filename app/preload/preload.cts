// Hands the backend's message port to the page (D32). A port cannot cross the
// context bridge, so it is posted to the page's own window, the pattern
// Electron documents for MessagePorts under context isolation.
import { contextBridge, ipcRenderer } from 'electron';

ipcRenderer.on('backend-port', (event) => {
  window.postMessage('mcpx:backend-port', '*', event.ports);
});

// The popped-out pane is told its selection as soon as it loads, which can be
// before the page has mounted a listener. The last one is kept and replayed.
// A wire log unit, or a surface entry (board 5.1A), which the window fetches itself.
type Selection = { id: number; reserialized: boolean } | { serverId: string; list: string; key: string } | null;
let lastSelection: Selection | undefined;
const selectionListeners = new Set<(s: Selection) => void>();
ipcRenderer.on('readable-select', (_e, selection: Selection) => {
  lastSelection = selection;
  for (const l of selectionListeners) l(selection);
});

contextBridge.exposeInMainWorld('mcpxShell', {
  /** The backend process stopped without being asked; the page says so and offers a restart. */
  onBackendExit: (listener: (code: number) => void) => {
    ipcRenderer.on('backend-exit', (_e, code: number) => listener(code));
  },
  restartBackend: () => ipcRenderer.send('backend-restart'),
  /** Opens the readable pane in its own window (board 1A). */
  popOutReadable: () => ipcRenderer.send('readable-pop-out'),
  /** Tells the popped-out pane which unit or surface entry to show. */
  selectReadable: (selection: Selection) => ipcRenderer.send('readable-select', selection),
  /** Returns a function that stops listening: a page given a new backend port listens again with its new client. */
  onReadableSelect: (listener: (selection: Selection) => void) => {
    selectionListeners.add(listener);
    if (lastSelection !== undefined) listener(lastSelection);
    return () => { selectionListeners.delete(listener); };
  },
  /** The popped-out pane was closed; the side pane shows again. */
  onReadableClosed: (listener: () => void) => {
    ipcRenderer.on('readable-closed', () => listener());
  },
  /** The system folder dialog, for a project whose config files to import. */
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('choose-folder'),
});
