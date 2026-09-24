// Hands the backend's message port to the page (D32). A port cannot cross the
// context bridge, so it is posted to the page's own window, the pattern
// Electron documents for MessagePorts under context isolation.
import { contextBridge, ipcRenderer } from 'electron';

ipcRenderer.on('backend-port', (event) => {
  window.postMessage('mcpx:backend-port', '*', event.ports);
});

contextBridge.exposeInMainWorld('mcpxShell', {
  /** The backend process stopped without being asked; the page says so and offers a restart. */
  onBackendExit: (listener: (code: number) => void) => {
    ipcRenderer.on('backend-exit', (_e, code: number) => listener(code));
  },
  restartBackend: () => ipcRenderer.send('backend-restart'),
});
