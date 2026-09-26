// The Electron main process: windows, the backend utility process, and the
// process trees it must never leave behind (D32, D36). No product logic.
import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, shell, utilityProcess, type UtilityProcess } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killServerTree, type ServerRoot } from '../../packages/platform/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
/** How long the backend gets to close its connections on quit before the trees are killed anyway. */
const SHUTDOWN_GRACE_MS = 10_000;

// A data directory given explicitly (the smoke tests, a portable run) also
// holds the renderer's own storage, such as remembered pane sizes, so one
// run cannot inherit another's. Unset, both stay in the default userData.
if (process.env.MCPX_DATA_DIR) app.setPath('userData', process.env.MCPX_DATA_DIR);

let backend: UtilityProcess | undefined;
/** The live stdio servers' root processes, as the backend last reported them. */
let serverRoots: ServerRoot[] = [];
let quitting = false;
let shutDown = false;

function startBackend(): UtilityProcess {
  const child = utilityProcess.fork(join(here, '..', 'host', 'backend-host.mjs'), [], {
    serviceName: 'MCP Explorer backend',
    stdio: 'inherit',
    env: { ...process.env, MCPX_DATA_DIR: process.env.MCPX_DATA_DIR ?? app.getPath('userData') },
  });
  child.on('message', (m: { kind: string; roots?: ServerRoot[] }) => {
    if (m.kind === 'processes' && m.roots) serverRoots = m.roots;
  });
  child.on('exit', (code) => {
    if (backend === child) backend = undefined;
    // D36: the backend died, so nothing will close its servers. On Linux
    // their roots are still alive; on Windows the roots died with the backend
    // and what they started is found by its recorded parent (platform/orphans).
    void killServerTrees();
    if (!quitting) for (const w of BrowserWindow.getAllWindows()) w.webContents.send('backend-exit', code);
  });
  return child;
}

async function killServerTrees(): Promise<void> {
  const roots = serverRoots;
  serverRoots = [];
  // A tree that could not be ended is said so on stderr, never dropped silently.
  await Promise.all(roots.map((root) => killServerTree(root).catch((e: unknown) => {
    console.error(`could not end the process tree of server process ${root.pid}: ${e instanceof Error ? e.message : String(e)}`);
  })));
}

/** Gives a window its own port to the backend. */
function connect(win: BrowserWindow): void {
  if (!backend) return;
  const { port1, port2 } = new MessageChannelMain();
  backend.postMessage({ kind: 'port' }, [port1]);
  win.webContents.postMessage('backend-port', null, [port2]);
}

let mainWindow: BrowserWindow | undefined;
let readableWindow: BrowserWindow | undefined;
let lastSelection: unknown = null;

function createWindow(route = '', size = { width: 1400, height: 900, minWidth: 900, minHeight: 600 }): BrowserWindow {
  const win = new BrowserWindow({
    ...size,
    title: route === 'readable' ? 'MCP Explorer: readable' : 'MCP Explorer',
    // The packaged executable carries build/icon.ico; this is the window's
    // own icon, which Linux shows and a dev run needs (npm run icons).
    // electron-builder leaves build/ out of the app, so a package ships the
    // PNG as an extra resource beside it.
    icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png'),
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
  if (dev) void win.loadURL(route ? `${dev}#${route}` : dev);
  else void win.loadFile(join(here, '..', 'renderer', 'index.html'), route ? { hash: route } : undefined);
  return win;
}

// Board 1A: the readable pane pops out into its own window. The main window
// says what is selected; this process passes it on.
ipcMain.on('readable-pop-out', () => {
  if (readableWindow) return void readableWindow.focus();
  readableWindow = createWindow('readable', { width: 560, height: 800, minWidth: 360, minHeight: 300 });
  readableWindow.webContents.on('did-finish-load', () => readableWindow?.webContents.send('readable-select', lastSelection));
  readableWindow.on('closed', () => {
    readableWindow = undefined;
    mainWindow?.webContents.send('readable-closed');
  });
});

ipcMain.on('readable-select', (_e, selection: unknown) => {
  lastSelection = selection;
  readableWindow?.webContents.send('readable-select', selection);
});

// Config import asks for a project folder; the user picks it in the system dialog.
ipcMain.handle('choose-folder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const options = { title: 'Choose a project folder', properties: ['openDirectory' as const] };
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return r.canceled ? null : (r.filePaths[0] ?? null);
});

// URL-mode elicitation (phase 08 decision 9): a server's URL opens in the
// system browser only when the person presses Open, and only over http or
// https. The string opened is the one the page showed, not a re-serialization.
ipcMain.handle('open-external', async (_e, url: unknown) => {
  if (typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  await shell.openExternal(url);
  return true;
});

// Every window's port died with the old backend, not only the asking one's:
// the popped-out readable pane needs a new port too (deferred/phase-04). A
// request while the backend is running (a second click) changes nothing: a new
// port remounts the page and drops what it was showing.
ipcMain.on('backend-restart', () => {
  if (backend) return;
  backend = startBackend();
  for (const win of BrowserWindow.getAllWindows()) connect(win);
});

app.whenReady().then(() => {
  backend = startBackend();
  mainWindow = createWindow();
  mainWindow.on('closed', () => {
    mainWindow = undefined;
    readableWindow?.close();
  });
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
