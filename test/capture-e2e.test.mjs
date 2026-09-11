// End-to-end: capture against the real fixture servers over stdio. The unit
// tests prove the logic; these prove it survives an actual protocol session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectStdio, captureSurface, hashSurface, diffSurfaces, surfaceChangeCount } from '../packages/protocol/dist/index.js';

const fixtures = fileURLToPath(new URL('../scripts/fixture/', import.meta.url));

async function capture(server, env = {}) {
  const conn = await connectStdio({
    command: process.execPath,
    args: [join(fixtures, server)],
    env: { ...process.env, ...env },
  });
  try {
    return { surface: await captureSurface(conn.source), era: conn.era, revision: conn.revision };
  } finally {
    await conn.close();
  }
}

test('ten connects to the shuffling modern fixture produce one hash', async () => {
  const hashes = new Set();
  for (let i = 0; i < 10; i++) {
    const { surface } = await capture('modern-server.mjs');
    hashes.add(hashSurface(surface));
  }
  assert.equal(hashes.size, 1, `expected one hash across ten sessions, got ${hashes.size}`);
});

test('a paginated fixture with 250 tools captures all 250', async () => {
  const { surface } = await capture('modern-server.mjs', { TOOL_COUNT: '250', PAGE_SIZE: '7' });
  assert.equal(surface.tools.length, 250);
  const names = new Set(surface.tools.map((t) => t.name));
  assert.equal(names.size, 250, 'no duplicates across pages');
  assert.ok(names.has('tool-0') && names.has('tool-249'), 'first and last page both captured');
});

test('the modern fixture is reached as the modern era', async () => {
  const { era, revision } = await capture('modern-server.mjs');
  assert.equal(era, 'modern');
  assert.equal(revision, '2026-07-28');
});

test('the legacy fixture is reached as the legacy era', async () => {
  const { era, revision } = await capture('legacy-server.mjs');
  assert.equal(era, 'legacy');
  assert.equal(revision, '2025-06-18');
});

test('a server that dies on the probe is still captured, via the fallback', async () => {
  const { surface, era } = await capture('legacy-server.mjs', { HOSTILE_PREINIT: '1' });
  assert.equal(era, 'legacy');
  assert.equal(surface.tools.length, 1);
  assert.equal(surface.tools[0].name, 'echo');
});

test('both eras normalize the same shared field, and differ only where the revision does', async () => {
  const legacy = (await capture('legacy-server.mjs')).surface;
  const modern = (await capture('modern-server.mjs')).surface;

  // Both fixtures expose a tool called echo with the same description; the
  // normalized model must present it identically despite two wire shapes.
  const l = legacy.tools.find((t) => t.name === 'echo');
  const m = modern.tools.find((t) => t.name === 'echo');
  assert.equal(l.description, m.description);

  // 2025-06-18 introduced outputSchema, so the legacy fixture CAN express it;
  // icons did not arrive until 2025-11-25, so it cannot. The model must say
  // which rather than leaving both merely absent.
  assert.ok(legacy.unavailable.includes('tool.icons'), 'icons postdate 2025-06-18');
  assert.ok(!legacy.unavailable.includes('tool.outputSchema'), 'outputSchema arrived in 2025-06-18');
  assert.ok(!modern.unavailable.includes('tool.icons'), 'modern can express icons');

  const d = diffSurfaces(legacy, modern);
  assert.deepEqual(d.revisionChanged, { from: '2025-06-18', to: '2026-07-28' });
});

test('two captures of an unchanged server diff to nothing', async () => {
  const a = (await capture('modern-server.mjs')).surface;
  const b = (await capture('modern-server.mjs')).surface;
  const d = diffSurfaces(a, b);
  assert.equal(d.identical, true, `expected no diff, got ${surfaceChangeCount(d)} surface changes`);
});

test('a server that advertises a capability and refuses it is reported, not fatal', async () => {
  // The defect this app exists to reveal: capabilities say prompts and
  // resources exist, the endpoints return -32601. One broken list must not
  // cost the user every other surface the server does expose.
  const { surface } = await capture('modern-server.mjs', { LIE_ABOUT: 'prompts,resources' });

  assert.ok(surface.tools.length > 0, 'tools were still captured');
  assert.deepEqual(surface.prompts, []);
  assert.deepEqual(surface.resources, []);

  const broken = surface.problems.map((p) => p.endpoint).sort();
  assert.deepEqual(broken, ['prompts/list', 'resources/list']);
  assert.ok(/Method not found/.test(surface.problems[0].message), `message kept: ${surface.problems[0].message}`);
});

test('a refused endpoint removes its surface, and the hash follows', async () => {
  // Not a contradiction of "problems are never hashed": the problem itself is
  // excluded, but the prompts it cost us are genuinely gone from the surface,
  // so the hash must move. The claim that problems are not hashed is pinned
  // directly in canonical.test.mjs, where the surface can be held constant.
  const healthy = (await capture('modern-server.mjs')).surface;
  const broken = (await capture('modern-server.mjs', { LIE_ABOUT: 'prompts' })).surface;
  assert.ok(broken.problems.length > 0, 'the run really was broken');
  assert.ok(healthy.prompts.length > 0 && broken.prompts.length === 0, 'prompts vanished');
  assert.notEqual(hashSurface(healthy), hashSurface(broken));
});
