// The diff must separate "the server changed" from "the revision changed".
// A revision upgrade genuinely changes what an agent receives, but reporting
// it as fifty changed tools buries the signal it exists to surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSurfaces, diffJson, surfaceChangeCount, captureSurface, hashSurface } from '../packages/protocol/dist/index.js';

const surface = async (over = {}, tools = [{ name: 'echo', description: 'Echoes.', inputSchema: { type: 'object' } }]) =>
  captureSurface({
    revision: '2026-07-28', era: 'modern', capabilities: { tools: {} },
    serverInfo: { name: 'fixture', version: '1.0.0' }, instructions: 'hello',
    async listTools() { return { items: tools }; },
    ...over,
  });

test('identical surfaces diff to nothing', async () => {
  const d = diffSurfaces(await surface(), await surface());
  assert.equal(d.identical, true);
  assert.equal(surfaceChangeCount(d), 0);
});

test('added, removed and changed tools fall out of the join', async () => {
  const before = await surface({}, [{ name: 'a', inputSchema: {} }, { name: 'b', inputSchema: {} }]);
  const after = await surface({}, [{ name: 'a', inputSchema: {}, description: 'now documented' }, { name: 'c', inputSchema: {} }]);
  const d = diffSurfaces(before, after);
  assert.deepEqual(d.tools, [
    { key: 'a', kind: 'changed', fields: [{ path: '/description', kind: 'added', after: 'now documented' }] },
    { key: 'b', kind: 'removed' },
    { key: 'c', kind: 'added' },
  ]);
});

test('a version bump with an identical surface reports identity, not surface', async () => {
  const before = await surface();
  const after = await surface({ serverInfo: { name: 'fixture', version: '2.0.0' } });
  const d = diffSurfaces(before, after);
  assert.equal(d.identical, false);
  assert.deepEqual(d.identityChanged, [{ field: 'serverVersion', from: '1.0.0', to: '2.0.0' }]);
  assert.equal(surfaceChangeCount(d), 0, 'a version bump is not a surface change');
  assert.equal(d.tools.length, 0);
});

test('a revision change is reported apart from the surface', async () => {
  const before = await surface({ revision: '2025-06-18', era: 'legacy' });
  const after = await surface();
  const d = diffSurfaces(before, after);
  assert.deepEqual(d.revisionChanged, { from: '2025-06-18', to: '2026-07-28' });
  assert.equal(surfaceChangeCount(d), 0, 'the tools did not change, only the revision');
});

test('instructions and capabilities are tracked', async () => {
  const d = diffSurfaces(await surface(), await surface({ instructions: 'different', capabilities: { tools: {}, prompts: {} } }));
  assert.equal(d.instructionsChanged, true);
  assert.equal(d.capabilitiesChanged, true);
  assert.equal(surfaceChangeCount(d), 2);
});

test('the diff is not keyed on which server a surface came from', async () => {
  // Cross-server comparison is later a selection change, not a feature -- so
  // two surfaces from differently-named servers must still diff by tool name.
  const d = diffSurfaces(await surface({ serverInfo: { name: 'alpha', version: '1' } }), await surface({ serverInfo: { name: 'beta', version: '1' } }));
  assert.equal(d.tools.length, 0, 'same tools, different servers');
  assert.deepEqual(d.identityChanged, [{ field: 'serverName', from: 'alpha', to: 'beta' }]);
});

test('capabilities differing only in key order are not a change', async () => {
  // JSON object key order is not guaranteed by the protocol -- this project's
  // own modern fixture shuffles it deliberately. The hash canonicalizes keys,
  // so if the diff does not, the two contradict each other: same hash, yet the
  // diff claims capabilities changed.
  const a = await surface({ capabilities: { tools: {}, prompts: {}, resources: {} } });
  const b = await surface({ capabilities: { resources: {}, tools: {}, prompts: {} } });
  assert.equal(hashSurface(a), hashSurface(b), 'precondition: the hash already ignores key order');
  const d = diffSurfaces(a, b);
  assert.equal(d.capabilitiesChanged, false, 'key order is not a capability change');
  assert.equal(d.identical, true, 'the diff must agree with the hash');
});

test('a real capability difference is still a change', async () => {
  const d = diffSurfaces(
    await surface({ capabilities: { tools: {} } }),
    await surface({ capabilities: { tools: {}, prompts: {} } }),
  );
  assert.equal(d.capabilitiesChanged, true);
});

// Phase 09 decision 3: a changed item says where, down to the field.
test('a changed tool lists the paths that differ inside its schema', async () => {
  const schema = (extra) => ({ type: 'object', properties: { text: { type: 'string', description: 'What to echo.' }, ...extra }, required: ['text'] });
  const before = await surface({}, [{ name: 'echo', inputSchema: schema({}) }]);
  const after = await surface({}, [{ name: 'echo', inputSchema: { ...schema({ 'a/b~c': { type: 'boolean' } }), required: ['text', 'a/b~c'] } }]);
  assert.deepEqual(diffSurfaces(before, after).tools[0].fields, [
    { path: '/inputSchema/properties/a~1b~0c', kind: 'added', after: { type: 'boolean' } },
    { path: '/inputSchema/required/1', kind: 'added', after: 'a/b~c' },
  ]);
});

test('fields outside the allowlist never appear, and key order is not a change', () => {
  assert.deepEqual(diffJson({ b: 1, a: { y: 2, x: 1 } }, { a: { x: 1, y: 2 }, b: 1 }), []);
  assert.deepEqual(diffJson({ a: [1, 2] }, { a: [2, 1] }), [
    { path: '/a/0', kind: 'changed', before: 1, after: 2 },
    { path: '/a/1', kind: 'changed', before: 2, after: 1 },
  ], 'array order is part of the value, as it is for the hash');
  assert.deepEqual(diffJson({ a: 1 }, { a: '1' }), [{ path: '/a', kind: 'changed', before: 1, after: '1' }]);
  assert.deepEqual(diffJson({ a: {} }, { a: [] }), [{ path: '/a', kind: 'changed', before: {}, after: [] }]);
  assert.deepEqual(diffJson({ a: null }, {}), [{ path: '/a', kind: 'removed', before: null }]);
});

test('a changed tool whose only difference is a non-surface field is not changed', async () => {
  const before = await surface({}, [{ name: 'echo', inputSchema: {} }]);
  const after = await surface({}, [{ name: 'echo', inputSchema: {}, _meta: { x: 1 } }]);
  assert.deepEqual(diffSurfaces(before, after).tools, []);
});

test('instructions and capabilities carry what changed', async () => {
  const d = diffSurfaces(await surface(), await surface({ instructions: undefined, capabilities: { tools: { listChanged: true } } }));
  assert.deepEqual(d.instructions, { before: 'hello' });
  assert.deepEqual(d.capabilityChanges, [{ path: '/tools/listChanged', kind: 'added', after: true }]);
  const same = diffSurfaces(await surface(), await surface());
  assert.equal('instructions' in same, false);
  assert.equal('capabilityChanges' in same, false);
});

test('a field-level diff reads only allowlisted fields, whatever the surface object holds', () => {
  const raw = (tool) => ({ revision: '2026-07-28', era: 'modern', capabilities: {}, tools: [tool], prompts: [], resources: [], resourceTemplates: [], unavailable: [], problems: [] });
  const d = diffSurfaces(raw({ name: 'e', description: 'a', inputSchema: {}, _meta: { x: 1 } }), raw({ name: 'e', description: 'b', inputSchema: {}, _meta: { x: 2 } }));
  assert.deepEqual(d.tools[0].fields.map((f) => f.path), ['/description']);
});
