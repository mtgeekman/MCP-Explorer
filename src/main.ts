// Phase 00 spike: prove an encrypted SQLite round trip inside packaged Electron,
// and prove the MCP client loads. Throwaway; phase 01 replaces it.
import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

type Finding = { check: string; ok: boolean; detail: string };
const findings: Finding[] = [];

function record(check: string, ok: boolean, detail: string) {
  findings.push({ check, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${check} :: ${detail}`);
}

function encryptedRoundTrip() {
  const Database = require('better-sqlite3-multiple-ciphers');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpx-spike-'));
  const dbPath = path.join(dir, 'workspace.db');
  const key = 'phase00-spike-key';

  const db = new Database(dbPath);
  db.pragma(`key='${key}'`);
  db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)');
  db.prepare('INSERT INTO probe (note) VALUES (?)').run('written under encryption');
  const row = db.prepare('SELECT note FROM probe WHERE id = 1').get() as { note: string };
  db.close();
  record('encrypted write+read', row.note === 'written under encryption', row.note);

  // The bytes on disk must not contain the plaintext, or "encrypted" is a lie.
  const raw = fs.readFileSync(dbPath);
  const leaks = raw.includes(Buffer.from('written under encryption'));
  record('ciphertext on disk', !leaks, leaks ? 'PLAINTEXT FOUND IN FILE' : `${raw.length} bytes, no plaintext`);

  // Opening without the key must fail, and must fail BECAUSE the file is
  // encrypted. A bare catch would report PASS for an unrelated error -- a
  // missing file, a permissions problem, a module that failed to load -- which
  // turns the one assertion that proves encryption into a false positive
  // exactly when the environment is broken.
  let opened = false;
  let refusal = '';
  try {
    const db2 = new Database(dbPath);
    db2.prepare('SELECT note FROM probe').get();
    db2.close();
    opened = true;
  } catch (e: any) {
    refusal = e.message ?? String(e);
  }
  const cipherRefusal = /not a database|encrypted|file is not/i.test(refusal);
  record(
    'unkeyed open refused',
    !opened && cipherRefusal,
    opened ? 'OPENED WITHOUT KEY' : `${refusal}${cipherRefusal ? '' : ' <- not a decryption refusal'}`
  );

  // Windows holds the file briefly after close(); retry rather than fail the run.
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  }
}

function nativeModuleProvenance() {
  const p = require.resolve('better-sqlite3-multiple-ciphers');
  const root = path.dirname(path.dirname(p));
  const built = fs.existsSync(path.join(root, 'build', 'Release'));
  const prebuilds = fs.existsSync(path.join(root, 'prebuilds'))
    ? fs.readdirSync(path.join(root, 'prebuilds'))
    : [];
  record(
    'loaded from prebuild, not a rebuild',
    !built && prebuilds.length > 0,
    `build/Release ${built ? 'EXISTS' : 'absent'}; prebuilds: ${prebuilds.join(', ')}`
  );
  record(
    'macOS prebuilds present (D11 gate)',
    prebuilds.some((f) => f.startsWith('darwin-')),
    prebuilds.filter((f) => f.startsWith('darwin-')).join(', ') || 'NONE'
  );
}

app.whenReady().then(async () => {
  record('electron runtime', true, `electron ${process.versions.electron}, node ${process.versions.node}, abi ${process.versions.modules}`);
  try {
    nativeModuleProvenance();
    encryptedRoundTrip();
  } catch (e: any) {
    record('native module', false, e.stack || e.message);
  }

  // The v2 client is ESM-only ("type": "module"); this main process is CommonJS.
  // Dynamic import is the bridge, and it must survive packaging into an asar.
  try {
    const mod: any = await import('@modelcontextprotocol/client');
    const stdio: any = await import('@modelcontextprotocol/client/stdio');
    record('ESM client loads from CJS main', typeof mod.Client === 'function' && typeof stdio.StdioClientTransport === 'function',
      `Client=${typeof mod.Client}, StdioClientTransport=${typeof stdio.StdioClientTransport}`);
  } catch (e: any) {
    record('ESM client loads from CJS main', false, e.message);
  }

  // Loading the client proves packaging. Connecting proves the seam survives it.
  const childErrRef = { v: '' };
  try {
    const { Client }: any = await import('@modelcontextprotocol/client');
    const { StdioClientTransport }: any = await import('@modelcontextprotocol/client/stdio');

    // Subclassing shifts the prototype, so the SDK negotiates over this process
    // instead of a disposable sibling -- which is what makes every frame visible.
    const Base: new (o: any) => any = StdioClientTransport;
    class SeamStdioTransport extends Base {}

    const sent: any[] = [];
    const server = path.join(__dirname, 'fixture', 'legacy-server.mjs');
    const frameLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcpx-seam-')), 'frames.log');
    fs.writeFileSync(frameLog, '');

    const inner = new SeamStdioTransport({
      command: process.execPath,
      args: [server],
      env: { ...process.env, FRAME_LOG: frameLog, ELECTRON_RUN_AS_NODE: '1' },
      stderr: 'pipe',
    });
    // Same decoding hazard as the fixture's stdin: decode the stream, not each
    // chunk, or a split multi-byte character corrupts the diagnostic we keep
    // this stderr for in the first place.
    inner.stderr?.setEncoding('utf8');
    inner.stderr?.on('data', (d: string) => { childErrRef.v += d; });
    const transport = new Proxy(inner, {
      get(t: any, p: any, r: any) {
        if (p === 'send') return async (m: any, o: any) => { for (const f of Array.isArray(m) ? m : [m]) sent.push(f); return t.send(m, o); };
        const v = Reflect.get(t, p, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
      set(t: any, p: any, v: any) {
        if (p === 'onmessage') { t.onmessage = (m: any, x: any) => v?.(m, x); return true; }
        return Reflect.set(t, p, v);
      },
    });

    const client = new Client({ name: 'mcp-explorer-phase00', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
    const tools = await client.listTools();
    await client.close();

    const received = fs.readFileSync(frameLog, 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).length;
    record('MCP connect from packaged app', tools.tools.length === 1, `listed ${tools.tools.length} tool(s)`);
    record('P1 seam complete (tapped == received)', sent.length === received, `tapped ${sent.length}, server received ${received}`);
  } catch (e: any) {
    record('MCP connect from packaged app', false, (e.message || String(e)) + ' | child stderr: ' + (childErrRef.v || '(empty)'));
  }

  const win = new BrowserWindow({ width: 700, height: 480, show: false });
  let loaded = false;
  let loadDetail = '';
  try {
    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    // Ask the document itself rather than the loader's state: isLoading() is
    // still racy the instant loadFile resolves, and a URL proves navigation
    // was attempted, not that anything rendered.
    const title = await win.webContents.executeJavaScript('document.title');
    loaded = title === 'MCP Explorer — Phase 00 spike';
    loadDetail = `document.title = ${JSON.stringify(title)}`;
  } catch (e: any) {
    loadDetail = e.message ?? String(e);
  }
  record('window loaded', loaded, loadDetail || 'no URL after load');

  const out = path.join(process.cwd(), 'phase00-findings.json');
  fs.writeFileSync(out, JSON.stringify({ platform: process.platform, arch: process.arch, versions: process.versions, findings }, null, 2));
  console.log(`\nwrote ${out}`);
  const failed = findings.filter((f) => !f.ok);
  app.exit(failed.length === 0 ? 0 : 1);
}).catch((e: unknown) => {
  // Without this the process hangs: app.exit() is never reached, no findings
  // are written, and CI waits for a timeout instead of reading a failure.
  const err = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(`[FAIL] harness aborted :: ${err}`);
  app.exit(1);
});
