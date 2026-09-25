// How a connection fails, and how it ends (plan phase 04; spec D20, D36).
// Every failure must say what the process or server did first: the three
// "it did not connect" bugs -- never started, died during negotiation,
// answered but could not negotiate -- have three different fixes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { connectStdio, connectHttp, captureSurface, ConnectError } from '../packages/protocol/dist/index.js';
import { fixtures, listen } from './support/fixture-servers.mjs';

const children = [];
after(() => { for (const c of children) c.kill(); });

const modern = join(fixtures, 'modern-server.mjs');
const legacy = join(fixtures, 'legacy-server.mjs');
const node = (script, env = {}, extra = {}) => ({ command: process.execPath, args: [script], env: { ...process.env, ...env }, ...extra });
const appEvents = (units) => units.filter((u) => u.kind === 'app').map((u) => JSON.parse(Buffer.from(u.bytes).toString('utf8')));

async function failure(connect) {
  try {
    const conn = await connect;
    await conn.close();
  } catch (e) {
    assert.ok(e instanceof ConnectError, `not a ConnectError: ${e?.stack ?? e}`);
    return e;
  }
  assert.fail('connected, and was expected not to');
}

// --- stdio: the three failures ------------------------------------------------------------

test('stdio: a command that does not exist is "never started", not a negotiation error', async () => {
  const units = [];
  const e = await failure(connectStdio({ command: 'mcpx-no-such-command-anywhere', onUnit: (u) => units.push(u) }));
  assert.equal(e.failure.kind, 'not-started');
  assert.equal(e.failure.errorCode, 'ENOENT');
  assert.ok(appEvents(units).some((a) => a.event === 'not-started' && a.command === 'mcpx-no-such-command-anywhere'));
});

test('stdio: a process that dies on the probe says so, with its exit code and the request it died on', async () => {
  const e = await failure(connectStdio(node(legacy, { HOSTILE_PREINIT: '1' })));
  assert.deepEqual({ ...e.failure, exit: { code: e.failure.exit.code } }, { kind: 'exited', exit: { code: 1 }, lastRequest: 'server/discover', diedOnProbe: true });
  assert.ok(e.failure.exit.lifetimeMs >= 0);
});

test('stdio: a server pinned legacy that now answers -32022 is reported with the versions it listed, and not restarted', async () => {
  const units = [];
  const e = await failure(connectStdio(node(modern, { INITIALIZE_UNSUPPORTED: '1' }, { era: 'legacy', onUnit: (u) => units.push(u) })));
  assert.deepEqual(e.failure, { kind: 'unsupported-version', supported: ['2026-07-28'] });
  assert.equal(appEvents(units).filter((a) => a.event === 'spawned').length, 1, 'D20: a second spawn is the user\'s decision');
});

test('stdio: pinned legacy sends initialize with no probe at all', async () => {
  const units = [];
  const conn = await connectStdio(node(legacy, {}, { era: 'legacy', onUnit: (u) => units.push(u) }));
  await conn.close();
  const sent = units.filter((u) => u.kind === 'wire' && u.direction === 'out').map((u) => JSON.parse(Buffer.from(u.bytes).toString('utf8')).method);
  assert.equal(sent[0], 'initialize');
  assert.ok(!sent.includes('server/discover'));
  assert.equal(conn.era, 'legacy');
});

// --- stdio: how a session ends ------------------------------------------------------------

test('stdio: the spawn and the exit are app events in the log, and close reports the exit', async () => {
  const units = [];
  let closed;
  const conn = await connectStdio(node(modern, {}, { onUnit: (u) => units.push(u), onClose: (info) => { closed = info; } }));
  assert.ok(Number.isInteger(conn.pid));
  await conn.close();
  await waitFor(() => closed);
  const events = appEvents(units);
  assert.deepEqual(events.map((a) => a.event), ['spawned', 'exited']);
  assert.equal(events[0].pid, conn.pid);
  assert.equal(closed.exit.code, events[1].code);
});

test('stdio: a server that crashes mid-session ends the connection with its exit code', async () => {
  let closed;
  const conn = await connectStdio(node(modern, { EXIT_ON: 'tools/list' }, { onClose: (info) => { closed = info; } }));
  // captureSurface records a failed list as a problem rather than throwing,
  // so the end of the session is observed through onClose alone.
  await captureSurface(conn.source).catch(() => undefined);
  await waitFor(() => closed);
  assert.equal(closed.exit.code, 3);
});

// --- HTTP ---------------------------------------------------------------------------------

test('http: a legacy server over Streamable HTTP and over SSE is reached as legacy', async () => {
  for (const [file, kind] of [['http-server.mjs', 'streamable-http'], ['sse-server.mjs', 'sse']]) {
    const url = await listen(file, children, { LEGACY: '1' });
    const conn = await connectHttp({ url, kind });
    try {
      assert.equal(conn.era, 'legacy', kind);
      assert.equal((await captureSurface(conn.source)).tools.length, 1);
    } finally {
      await conn.close();
    }
  }
});

test('http: a probe that times out or drops the connection falls back to legacy on its own (D20)', async () => {
  for (const mode of ['SILENT_PREINIT', 'HOSTILE_PREINIT']) {
    const units = [];
    const url = await listen('http-server.mjs', children, { LEGACY: '1', [mode]: '1' });
    const conn = await connectHttp({ url, probeTimeoutMs: 500, onUnit: (u) => units.push(u) });
    try {
      assert.equal(conn.era, 'legacy', mode);
      assert.ok(appEvents(units).some((a) => a.event === 'legacy-fallback'), `${mode}: the fallback is not in the log`);
    } finally {
      await conn.close();
    }
  }
});

test('http: a server pinned legacy that answers -32022 is re-probed on its own, since nothing is spawned', async () => {
  const units = [];
  const url = await listen('http-server.mjs', children, { INITIALIZE_UNSUPPORTED: '1' });
  const conn = await connectHttp({ url, era: 'legacy', onUnit: (u) => units.push(u) });
  try {
    assert.equal(conn.era, 'modern');
    assert.deepEqual(appEvents(units).find((a) => a.event === 're-probe').supported, ['2026-07-28']);
  } finally {
    await conn.close();
  }
});

test('http: an error status is reported as the status, after the legacy fallback also fails', async () => {
  const units = [];
  const url = await listen('http-server.mjs', children, { HTML_REPLY: '1' });
  const e = await failure(connectHttp({ url, onUnit: (u) => units.push(u) }));
  assert.deepEqual(e.failure, { kind: 'http-status', status: 502 });
});

async function waitFor(check, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
