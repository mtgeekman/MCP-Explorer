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
  // .get() yields undefined when nothing matches. Dereferencing it threw a
  // TypeError that the caller's catch reported as a NATIVE MODULE failure --
  // blaming the wrong subsystem and skipping the two encryption assertions
  // below, which never ran.
  const row = db.prepare('SELECT note FROM probe WHERE id = 1').get() as { note: string } | undefined;
  db.close();
  record(
    'encrypted write+read',
    row?.note === 'written under encryption',
    row === undefined ? 'no row returned by SELECT' : row.note
  );

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
  // Uses the protocol package rather than a bespoke client: a second client
  // here would duplicate the transport tap and the era fallback, and P1's build
  // gate exists precisely to stop that drift.
  const childErrRef = { v: '' };
  try {
    const protocol: any = await import('../packages/protocol/dist/index.js');
    const frames: { direction: string }[] = [];
    const server = path.join(__dirname, 'fixture', 'legacy-server.mjs');

    const conn = await protocol.connectStdio({
      command: process.execPath,
      args: [server],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      onFrame: (direction: string) => frames.push({ direction }),
      // Without this the catch below reported "(empty)" unconditionally,
      // asserting the child printed nothing when nothing had ever looked.
      onStderr: (text: string) => { childErrRef.v += text; },
    });
    const surface = await protocol.captureSurface(conn.source);
    const hash = protocol.hashSurface(surface);
    await conn.close();

    record('MCP capture from packaged app', surface.tools.length === 1,
      `${surface.tools.length} tool(s), era ${conn.era}, hash ${String(hash).slice(0, 12)}`);
    record('P1 seam sees traffic in both directions',
      frames.some((f) => f.direction === 'out') && frames.some((f) => f.direction === 'in'),
      `${frames.filter((f) => f.direction === 'out').length} out, ${frames.filter((f) => f.direction === 'in').length} in`);
  } catch (e: any) {
    record('MCP capture from packaged app', false, (e.message || String(e)) + ' | child stderr: ' + (childErrRef.v || '(empty)'));
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

  // Not process.cwd(): that is the repository when run from a checkout, so
  // every run dirtied the working tree with machine-specific data and the file
  // ended up committed. Override with MCPX_FINDINGS_OUT when a caller wants it
  // somewhere specific, such as a CI artifact path.
  const out = process.env.MCPX_FINDINGS_OUT ?? path.join(os.tmpdir(), 'phase00-findings.json');
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
