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

  // Opening without the key must fail.
  let refused = false;
  let refusal = '';
  try {
    const db2 = new Database(dbPath);
    db2.prepare('SELECT note FROM probe').get();
    db2.close();
  } catch (e: any) {
    refused = true;
    refusal = e.message;
  }
  record('unkeyed open refused', refused, refusal || 'OPENED WITHOUT KEY');

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

  const win = new BrowserWindow({ width: 700, height: 480, show: false });
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  record('window loaded', true, 'BrowserWindow rendered a file');

  const out = path.join(process.cwd(), 'phase00-findings.json');
  fs.writeFileSync(out, JSON.stringify({ platform: process.platform, arch: process.arch, versions: process.versions, findings }, null, 2));
  console.log(`\nwrote ${out}`);
  const failed = findings.filter((f) => !f.ok);
  app.exit(failed.length === 0 ? 0 : 1);
});
