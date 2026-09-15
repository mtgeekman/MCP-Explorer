// P3 and the plan's acceptance criterion: the same server captured over every
// transport must produce the same surface. All three fixtures share one handler
// (modern-handler.mjs), so a difference here is the capture layer's, not the
// fixture's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectStdio, connectHttp, captureSurface, hashSurface } from '../packages/protocol/dist/index.js';

const fixtures = fileURLToPath(new URL('../scripts/fixture/', import.meta.url));
const children = [];
after(() => { for (const c of children) c.kill(); });

/** Start an HTTP fixture and wait for it to announce its port. */
async function listen(file) {
  const child = spawn(process.execPath, [join(fixtures, file)], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`${file} never announced a port`)), 10000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/LISTENING (\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
}

async function capture(connect) {
  const conn = await connect();
  try {
    return { surface: await captureSurface(conn.source), era: conn.era, revision: conn.revision };
  } finally {
    await conn.close();
  }
}

// Started once, before any test body runs. Declared here rather than at the
// foot of the file: relying on node:test deferring bodies past a const declared
// below them is true but far too subtle to leave in place.
const urls = { http: await listen('http-server.mjs'), sse: await listen('sse-server.mjs') };

test('the same surface is captured over stdio, Streamable HTTP and SSE', async () => {
  const viaStdio = await capture(() => connectStdio({
    command: process.execPath,
    args: [join(fixtures, 'modern-server.mjs')],
  }));
  const viaHttp = await capture(() => connectHttp({ url: urls.http }));
  const viaSse = await capture(() => connectHttp({ url: urls.sse, kind: 'sse' }));

  for (const [name, got] of [['streamable-http', viaHttp], ['sse', viaSse]]) {
    assert.equal(got.era, viaStdio.era, `${name} era`);
    assert.equal(got.revision, viaStdio.revision, `${name} revision`);
    assert.equal(
      hashSurface(got.surface),
      hashSurface(viaStdio.surface),
      `${name} produced a different surface hash than stdio`,
    );
  }

  assert.equal(viaStdio.surface.tools.length, 2);
  assert.equal(viaStdio.surface.prompts.length, 1);
  assert.equal(viaStdio.surface.resources.length, 1);
  assert.equal(viaStdio.surface.resourceTemplates.length, 1);
});

test('an HTTP transport still routes every frame through the P1 seam', async () => {
  const frames = [];
  const conn = await connectHttp({ url: urls.http, onFrame: (d, f) => frames.push([d, f]) });
  await captureSurface(conn.source);
  await conn.close();

  const out = frames.filter(([d]) => d === 'out').map(([, f]) => f.method);
  assert.ok(out.includes('server/discover'), 'the negotiation probe reached the logger');
  assert.ok(out.includes('tools/list'), 'ordinary traffic reached the logger');
});

// P1 cuts both ways: every frame reaches the log, and each frame reaches it
// once. The SDK chains transport.onmessage -- ProbeWindow saves and restores
// it, Protocol.connect() reads it and installs a handler that calls it -- so a
// tap that hands its own wrapper back on read gets wrapped twice, and every
// inbound frame is logged twice.
for (const [name, connect] of [
  ['stdio', (onFrame) => connectStdio({ command: process.execPath, args: [join(fixtures, 'modern-server.mjs')], onFrame })],
  ['streamable-http', (onFrame) => connectHttp({ url: urls.http, onFrame })],
  ['sse', (onFrame) => connectHttp({ url: urls.sse, kind: 'sse', onFrame })],
]) {
  test(`P1: over ${name}, every inbound frame is logged exactly once`, async () => {
    const inbound = [];
    const conn = await connect((d, f) => { if (d === 'in') inbound.push(f); });
    try {
      await captureSurface(conn.source);
    } finally {
      await conn.close();
    }
    assert.ok(inbound.length >= 5, `only ${inbound.length} inbound frames in a whole capture`);
    const twice = inbound.filter((f, i) => inbound.indexOf(f) !== i);
    assert.equal(twice.length, 0, `${twice.length} of ${inbound.length} inbound frames were logged more than once`);
    const ids = inbound.filter((f) => f.id !== undefined).map((f) => JSON.stringify(f.id));
    assert.equal(new Set(ids).size, ids.length, `a response id was logged more than once: ${ids.join(' ')}`);
  });
}
