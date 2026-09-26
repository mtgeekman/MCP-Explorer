// The D8 gate: a server that shuffles its output and changes its volatile
// cache hints on every response must still produce ONE surface hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureSurface, hashSurface, hashAll, canonicalJson, unavailableFields, eraOf, revisionIndex } from '../packages/protocol/dist/index.js';

const TOOLS = [
  { name: 'bravo', description: 'B', inputSchema: { type: 'object', properties: { b: { type: 'string' }, a: { type: 'number' } } } },
  { name: 'alpha', description: 'A', inputSchema: { type: 'object', properties: { z: { type: 'string' } } } },
];

const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(([, v]) => v);
const shuffleKeys = (o) =>
  Array.isArray(o) ? o.map(shuffleKeys)
  : o && typeof o === 'object' ? Object.fromEntries(shuffle(Object.entries(o)).map(([k, v]) => [k, shuffleKeys(v)]))
  : o;

// Mimics the modern fixture: shuffled order, shuffled keys, and volatile cache
// hints that a naive capture would carry into the hash.
function hostileSource(revision = '2026-07-28') {
  return {
    revision,
    era: eraOf(revision),
    serverInfo: { name: 'hostile', version: '1.0.0' },
    instructions: 'unchanging',
    capabilities: shuffleKeys({ tools: {}, prompts: {} }),
    async listTools() {
      return {
        items: shuffle(TOOLS.map(shuffleKeys)).map((t) => ({
          ...t,
          ttlMs: Math.floor(Math.random() * 100000),
          cacheScope: Math.random() < 0.5 ? 'public' : 'private',
          _meta: { nonce: Math.random() },
        })),
      };
    },
  };
}

test('ten hostile captures produce exactly one surface hash', async () => {
  const hashes = new Set();
  for (let i = 0; i < 10; i++) {
    hashes.add(hashSurface(await captureSurface(hostileSource())));
  }
  assert.equal(hashes.size, 1, `expected one hash across ten captures, got ${hashes.size}: ${[...hashes].map((h) => h.slice(0, 8)).join(', ')}`);
});

test('a real description change does move the hash', async () => {
  const before = hashSurface(await captureSurface(hostileSource()));
  const changed = hostileSource();
  const original = changed.listTools.bind(changed);
  changed.listTools = async () => {
    const page = await original();
    page.items[0] = { ...page.items[0], description: 'genuinely different' };
    return page;
  };
  assert.notEqual(hashSurface(await captureSurface(changed)), before);
});

test('canonicalJson sorts keys and drops undefined', () => {
  assert.equal(
    JSON.stringify(canonicalJson({ b: 1, a: { d: 2, c: 3 }, gone: undefined })),
    JSON.stringify({ a: { c: 3, d: 2 }, b: 1 }),
  );
});

test('per-item hashes are keyed by identity', async () => {
  const hashed = hashAll(await captureSurface(hostileSource()));
  assert.deepEqual([...hashed.tools.keys()].sort(), ['alpha', 'bravo']);
});

test('unavailable fields follow the revision window, withdrawals included', () => {
  const oldest = unavailableFields('2024-11-05');
  assert.ok(oldest.includes('tool.outputSchema'), 'outputSchema did not exist in 2024-11-05');
  assert.ok(oldest.includes('tool.icons'), 'icons did not exist in 2024-11-05');

  const newest = unavailableFields('2026-07-28');
  assert.ok(!newest.includes('tool.outputSchema'), 'outputSchema exists in 2026-07-28');
  // The withdrawal case: added in 2025-11-25, REMOVED in 2026-07-28. A table
  // that only recorded "since" would wrongly report this as available.
  assert.ok(newest.includes('tool.execution'), 'tool.execution was withdrawn in 2026-07-28');
  assert.ok(!unavailableFields('2025-11-25').includes('tool.execution'), 'tool.execution existed in 2025-11-25');
});

test('an unknown revision sorts as newer than every known one', () => {
  assert.ok(revisionIndex('2099-01-01') > revisionIndex('2026-07-28'));
  assert.equal(eraOf('2099-01-01'), 'modern');
});

// The ten-captures test above is an end-to-end property, and it survives the
// removal of EITHER guard because normalizeTool and canonicalSurface both drop
// unknown fields. Verified by mutation: removing one leaves it green, removing
// both yields ten distinct hashes. So each guard gets its own test below,
// otherwise a future edit could delete one and nothing would say so.

test('canonicalSurface ignores fields outside its allowlist', () => {
  const base = {
    revision: '2026-07-28', era: 'modern', capabilities: {},
    tools: [{ name: 'a', inputSchema: { type: 'object' } }],
    prompts: [], resources: [], resourceTemplates: [], unavailable: [],
  };
  const polluted = structuredClone(base);
  // Injected past normalization, straight into the model the hash reads.
  polluted.tools[0].ttlMs = 12345;
  polluted.tools[0].cacheScope = 'private';
  polluted.tools[0]._meta = { nonce: Math.random() };
  assert.equal(hashSurface(polluted), hashSurface(base), 'volatile fields reached the hash');
});

test('normalization drops fields the model does not declare', async () => {
  const surface = await captureSurface({
    revision: '2026-07-28', era: 'modern', capabilities: {},
    async listTools() {
      return { items: [{ name: 'a', inputSchema: { type: 'object' }, ttlMs: 999, cacheScope: 'public' }] };
    },
  });
  assert.deepEqual(Object.keys(surface.tools[0]).sort(), ['annotations', 'description', 'execution', 'icons', 'inputSchema', 'name', 'outputSchema', 'title']);
  assert.equal(surface.tools[0].ttlMs, undefined);
});

test('capture problems never reach the hash', () => {
  // Held constant: the same surface, one run with a recorded failure. A
  // transient error must not register as a new version in the history.
  const base = {
    revision: '2026-07-28', era: 'modern', capabilities: {},
    tools: [{ name: 'a', inputSchema: { type: 'object' } }],
    prompts: [], resources: [], resourceTemplates: [], unavailable: [], problems: [],
  };
  const withProblem = structuredClone(base);
  withProblem.problems = [{ endpoint: 'prompts/list', message: 'Method not found' }];
  assert.equal(hashSurface(withProblem), hashSurface(base), 'a recorded problem moved the hash');
});
