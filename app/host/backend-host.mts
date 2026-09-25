// The utility process (D32): storage, connections and every spawned server
// live here, so a keychain stall or a synchronous query never freezes a
// window. This file only wires ports; the backend itself is plain Node.
import { Backend, serve, type Message } from '../../packages/backend/dist/index.js';
import { keychainStore } from '../../packages/storage/dist/index.js';

/** From the main process: a port for a window, or the order to shut down. */
type FromMain = { kind: 'port' } | { kind: 'shutdown' };

const dataDir = process.env.MCPX_DATA_DIR;
if (!dataDir) throw new Error('MCPX_DATA_DIR is not set; the main process passes the app data directory');

const backend = new Backend({
  dataDir,
  secrets: keychainStore(),
  // D36: the main process kills these trees if this process dies.
  onProcesses: (roots) => process.parentPort.postMessage({ kind: 'processes', roots }),
});

process.parentPort.on('message', (e) => {
  const message = e.data as FromMain;
  if (message.kind === 'port') {
    const [port] = e.ports;
    serve(backend, {
      post: (m: Message) => port.postMessage(m),
      onMessage: (listener) => port.on('message', (event) => listener(event.data as Message)),
    });
    port.start();
  } else if (message.kind === 'shutdown') {
    backend.shutdown().finally(() => process.parentPort.postMessage({ kind: 'shutdown-done' }));
  }
});
