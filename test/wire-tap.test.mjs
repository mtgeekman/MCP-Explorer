// P1 and D34 end to end: the wire log holds the exact bytes that crossed the
// wire, on every transport, including the bytes the SDK itself drops. The
// parsed-message tap (onFrame) is the parity check: every message the SDK
// handled must have come from a logged unit, in the same order.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectStdio, connectHttp, captureSurface, sseEventData } from '../packages/protocol/dist/index.js';
import { fixtures, listen } from './support/fixture-servers.mjs';

const work = mkdtempSync(join(tmpdir(), 'mcpx-wiretap-'));
const children = [];
after(() => {
  for (const c of children) c.kill();
  rmSync(work, { recursive: true, force: true });
});

const modern = join(fixtures, 'modern-server.mjs');
let n = 0;
const file = (name) => {
  const p = join(work, `${++n}-${name}`);
  writeFileSync(p, '');
  return p;
};

/** Connects, captures the whole surface, closes; returns what both taps saw. */
async function session(connect) {
  const units = [];
  const frames = [];
  const conn = await connect({ onUnit: (u) => units.push(u), onFrame: (d, f) => frames.push([d, f]) });
  try {
    await captureSurface(conn.source);
  } finally {
    await conn.close();
  }
  return { units, frames };
}

const str = (u) => Buffer.from(u.bytes).toString('utf8');
const wire = (units, direction) => units.filter((u) => u.kind === 'wire' && u.direction === direction);

/** The JSON-RPC payload of a unit, or undefined when it carries none. */
function payload(u) {
  const t = u.http?.framing === 'sse-event' ? sseEventData(u.bytes) : str(u);
  if (t === null) return undefined;
  try {
    const v = JSON.parse(t);
    return typeof v === 'object' && v !== null && v.jsonrpc === '2.0' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Every message the SDK handled came from a logged unit, in order, in both directions. */
function assertParity({ units, frames }) {
  for (const direction of ['out', 'in']) {
    const logged = wire(units, direction).map(payload).filter((p) => p !== undefined);
    const handled = frames.filter(([d]) => d === direction).map(([, f]) => f);
    assert.ok(handled.length >= 2, `only ${handled.length} ${direction} messages`);
    assert.deepEqual(logged, handled, `${direction}: the logged units and the handled messages differ`);
  }
}

// --- stdio ------------------------------------------------------------------------------

test('stdio: every line in is logged as the exact bytes the server wrote', async () => {
  const log = file('wire.log');
  const seen = await session((taps) => connectStdio({ command: process.execPath, args: [modern], env: { ...process.env, ODD_BYTES: '1', WIRE_LOG: log }, ...taps }));
  const inBytes = Buffer.concat(wire(seen.units, 'in').map((u) => u.bytes));
  assert.ok(inBytes.includes(Buffer.from('  \r\n')), 'the fixture did not write its odd bytes');
  assert.deepEqual(inBytes, readFileSync(log));
  assertParity(seen);
});

test('stdio: every line out is logged as the bytes written to stdin, newline included', async () => {
  const log = file('frames.log');
  const seen = await session((taps) => connectStdio({ command: process.execPath, args: [modern], env: { ...process.env, FRAME_LOG: log }, ...taps }));
  const out = wire(seen.units, 'out').map(str);
  assert.ok(out.every((line) => line.endsWith('\n') && !line.slice(0, -1).includes('\n')));
  const received = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^IN {2}/, ''));
  assert.deepEqual(out.map((l) => l.slice(0, -1)), received, 'the log and the server disagree about what was sent');
  assertParity(seen);
});

test('stdio: a line that is not JSON is logged, though the SDK drops it', async () => {
  const seen = await session((taps) => connectStdio({ command: process.execPath, args: [modern], env: { ...process.env, MALFORMED: '1' }, ...taps }));
  assert.ok(wire(seen.units, 'in').some((u) => str(u) === 'this is not json\n'));
  assertParity(seen);
});

test('stdio: bytes after the last newline are logged when the server exits', async () => {
  const seen = await session((taps) => connectStdio({ command: process.execPath, args: [modern], env: { ...process.env, NO_FINAL_NEWLINE: '1' }, ...taps }));
  assert.equal(str(wire(seen.units, 'in').at(-1)), 'goodbye');
});

test('stdio: stderr is logged as its own units, bytes intact, a line without a newline included', async () => {
  const flood = 100_000;
  const seen = await session((taps) => connectStdio({ command: process.execPath, args: [modern], env: { ...process.env, STDERR_FLOOD: String(flood) }, ...taps }));
  const stderr = seen.units.filter((u) => u.kind === 'stderr');
  assert.ok(stderr.every((u) => u.direction === 'in'));
  assert.equal(Buffer.concat(stderr.map((u) => u.bytes)).toString('latin1'), 'x'.repeat(flood));
  assertParity(seen);
});

test('stdio: the logging transport still spawns the server once (D20)', async () => {
  const spawns = file('spawns.log');
  await session((taps) => connectStdio({ command: process.execPath, args: [modern], env: { ...process.env, SPAWN_LOG: spawns }, ...taps }));
  assert.equal(readFileSync(spawns, 'utf8').trim().split('\n').length, 1, 'a second spawn means SeamStdioTransport gained an own _dispose');
});

// --- Streamable HTTP -------------------------------------------------------------------

test('http: every body in is logged as the exact bytes the server wrote, requests and responses paired', async () => {
  const log = file('wire.log');
  const url = await listen('http-server.mjs', children, { WIRE_LOG: log });
  const seen = await session((taps) => connectHttp({ url, ...taps }));
  const bodies = wire(seen.units, 'in').filter((u) => u.bytes.length > 0).map((u) => Buffer.from(u.bytes).toString('hex'));
  assert.deepEqual(bodies, readFileSync(log, 'utf8').split('\n').filter(Boolean));
  for (const u of wire(seen.units, 'out')) assert.equal(u.http.method, 'POST');
  const exchanges = (d) => wire(seen.units, d).map((u) => u.http.exchange);
  assert.deepEqual(exchanges('in').sort((a, b) => a - b), exchanges('out'), 'every request has exactly one response unit');
  assertParity(seen);
});

test('http: an event-stream reply is logged one event per unit, comments included', async () => {
  const log = file('wire.log');
  const url = await listen('http-server.mjs', children, { SSE_REPLIES: '1', WIRE_LOG: log });
  const seen = await session((taps) => connectHttp({ url, ...taps }));
  const events = wire(seen.units, 'in').filter((u) => u.http.framing === 'sse-event');
  assert.ok(events.some((u) => str(u) === ': keepalive\r\n\r\n'));
  assert.ok(events.every((u) => str(u).endsWith('\r\n\r\n')));
  const byExchange = new Map();
  for (const u of events) byExchange.set(u.http.exchange, [...(byExchange.get(u.http.exchange) ?? []), u.bytes]);
  const logged = [...byExchange.values()].map((parts) => Buffer.concat(parts).toString('hex'));
  assert.deepEqual(logged, readFileSync(log, 'utf8').split('\n').filter(Boolean));
  assertParity(seen);
});

test('http: an HTML error page is logged as its bytes, with its status', async () => {
  const url = await listen('http-server.mjs', children, { HTML_REPLY: '1' });
  const units = [];
  await assert.rejects(connectHttp({ url, onUnit: (u) => units.push(u) }));
  const page = wire(units, 'in').find((u) => u.http.status === 502);
  assert.ok(page, 'no 502 unit was logged');
  assert.equal(str(page), '<!doctype html>\n<title>502 Bad Gateway</title>\n<h1>Bad Gateway</h1>\n');
  assert.match(page.http.headers['content-type'], /text\/html/);
});

test('D35: a secret header reaches the server and never the log', async () => {
  const headerLog = file('headers.log');
  const secret = 'Bearer s3cret-token-value';
  const url = await listen('http-server.mjs', children, { HEADER_LOG: headerLog });
  const seen = await session((taps) => connectHttp({ url, headers: { 'X-Trace': 'abc' }, secretHeaders: { Authorization: secret }, ...taps }));
  assert.ok(readFileSync(headerLog, 'utf8').split('\n').includes(secret), 'the server never received the secret header');
  const everything = JSON.stringify(seen.units.map((u) => ({ ...u, bytes: str(u) })));
  assert.ok(!everything.includes('s3cret'), 'a secret value reached the wire log');
  const request = wire(seen.units, 'out')[0];
  assert.equal(request.http.headers.authorization, '<secret: authorization>');
  assert.equal(request.http.headers['x-trace'], 'abc');
});

// --- HTTP+SSE (legacy transport) --------------------------------------------------------

test('sse transport: the stream, its endpoint event and every POST are logged as bytes', async () => {
  const url = await listen('sse-server.mjs', children);
  const seen = await session((taps) => connectHttp({ url, kind: 'sse', ...taps }));
  const events = wire(seen.units, 'in').filter((u) => u.http.framing === 'sse-event');
  assert.match(str(events[0]), /^event: endpoint\ndata: \/messages\?sessionId=[\w-]+\n\n$/);
  assert.ok(wire(seen.units, 'out').some((u) => u.http.method === 'GET'), 'the stream request was not logged');
  assert.ok(wire(seen.units, 'in').some((u) => u.http.status === 202 && u.bytes.length === 0), 'a POST acknowledgement was not logged');
  assertParity(seen);
});
