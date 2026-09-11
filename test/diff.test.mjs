// The diff must separate "the server changed" from "the revision changed".
// A revision upgrade genuinely changes what an agent receives, but reporting
// it as fifty changed tools buries the signal it exists to surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSurfaces, surfaceChangeCount, captureSurface, hashSurface } from '../packages/protocol/dist/index.js';

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
    { key: 'a', kind: 'changed' },
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
