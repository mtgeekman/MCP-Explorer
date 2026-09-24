// The Electron main process: windows, the backend utility process, and the
// process trees it must never leave behind (D32, D36). No product logic.
import { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess, type UtilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../../packages/platform/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
/** How long the backend gets to close its connections on quit before the trees are killed anyway. */
const SHUTDOWN_GRACE_MS = 10_000;

let backend: UtilityProcess | undefined;
/** The live stdio server PIDs, as the backend last reported them. */
let serverPids: number[] = [];
let quitting = false;
let shutDown = false;

function startBackend(): UtilityProcess {
  const child = utilityProcess.fork(join(here, '..', 'host', 'backend-host.mjs'), [], {
    serviceName: 'MCP Explorer backend',
    stdio: 'inherit',
    env: { ...process.env, MCPX_DATA_DIR: process.env.MCPX_DATA_DIR ?? app.getPath('userData') },
  });
  child.on('message', (m: { kind: string; pids?: number[] }) => {
    if (m.kind === 'processes' && m.pids) serverPids = m.pids;
  });
  child.on('exit', (code) => {
    if (backend === child) backend = undefined;
    // D36: the backend died, so nothing will close its servers. Their roots
    // are still alive, which is what a tree kill needs.
    void killServerTrees();
    if (!quitting) for (const w of BrowserWindow.getAllWindows()) w.webContents.send('backend-exit', code);
  });
  return child;
}

async function killServerTrees(): Promise<void> {
  const pids = serverPids;
  serverPids = [];
  await Promise.all(pids.map((pid) => killProcessTree(pid).catch(() => undefined)));
}

/** Gives a window its own port to the backend. */
function connect(win: BrowserWindow): void {
  if (!backend) return;
  const { port1, port2 } = new MessageChannelMain();
  backend.postMessage({ kind: 'port' }, [port1]);
  win.webContents.postMessage('backend-port', null, [port2]);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'MCP Explorer',
    webPreferences: {
      preload: join(here, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // The app shows local content only; a link a server hands over is never
  // followed by the window itself (P2).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('did-finish-load', () => connect(win));
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) void win.loadURL(dev);
  else void win.loadFile(join(here, '..', 'renderer', 'index.html'));
  return win;
}

ipcMain.on('backend-restart', (e) => {
  if (!backend) backend = startBackend();
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) connect(win);
});

app.whenReady().then(() => {
  backend = startBackend();
  createWindow();
});

app.on('window-all-closed', () => app.quit());

// Quit waits for the backend to close its connections, then kills whatever
// server trees are left, so a clean quit leaves nothing running (D36).
app.on('before-quit', (e) => {
  quitting = true;
  if (shutDown) return;
  e.preventDefault();
  const child = backend;
  let finishing = false;
  const finish = async () => {
    if (finishing) return;
    finishing = true;
    await killServerTrees();
    shutDown = true;
    app.quit();
  };
  if (!child) return void finish();
  const timer = setTimeout(() => { child.kill(); void finish(); }, SHUTDOWN_GRACE_MS);
  child.on('message', (m: { kind: string }) => {
    if (m.kind !== 'shutdown-done') return;
    clearTimeout(timer);
    void finish();
  });
  child.postMessage({ kind: 'shutdown' });
});
