// Pagination: a partial capture invents a phantom version, so the walk must
// either complete or fail loudly. It must also terminate against a server that
// will not stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureSurface, collectPages, PaginationError, MAX_PAGES } from '../packages/protocol/dist/index.js';

function paged(total, pageSize) {
  return async (cursor) => {
    const start = cursor ? Number(cursor) : 0;
    const items = Array.from({ length: Math.min(pageSize, total - start) }, (_, i) => ({ name: `tool-${start + i}` }));
    const next = start + pageSize;
    return { items, nextCursor: next < total ? String(next) : undefined };
  };
}

test('every page is walked before the list is returned', async () => {
  const items = await collectPages(paged(250, 10), 'tools/list');
  assert.equal(items.length, 250);
  assert.equal(items[0].name, 'tool-0');
  assert.equal(items[249].name, 'tool-249');
});

test('a single unpaginated page still works', async () => {
  assert.equal((await collectPages(paged(3, 100), 'tools/list')).length, 3);
});

test('a repeated cursor is refused rather than looped on', async () => {
  const stuck = async () => ({ items: [{ name: 'x' }], nextCursor: 'same' });
  await assert.rejects(
    () => collectPages(stuck, 'tools/list'),
    (e) => e instanceof PaginationError && /repeated pagination cursor/.test(e.message),
  );
});

test('an endless walk of fresh cursors is bounded', async () => {
  let n = 0;
  const endless = async () => ({ items: [{ name: `x${n}` }], nextCursor: String(n++) });
  await assert.rejects(
    () => collectPages(endless, 'tools/list'),
    (e) => e instanceof PaginationError && e.message.includes(String(MAX_PAGES)),
  );
});

test('a capture paginates every list independently', async () => {
  const s = await captureSurface({
    revision: '2026-07-28', era: 'modern', capabilities: {},
    listTools: paged(25, 7),
    listPrompts: paged(3, 2),
  });
  assert.equal(s.tools.length, 25);
  assert.equal(s.prompts.length, 3);
  // A capability the server does not advertise is absent, not an error.
  assert.deepEqual(s.resources, []);
});

test('duplicate identity keys are reported, not silently collapsed', async () => {
  // Name-keyed hashing and diffing are deliberate, but they mean a repeated
  // name keeps only the survivor. A server exposing two tools called `echo` is
  // broken -- an agent cannot address the second -- and this app exists to
  // reveal that rather than quietly show one of them.
  const s = await captureSurface({
    revision: '2026-07-28', era: 'modern', capabilities: {},
    async listTools() {
      return { items: [
        { name: 'echo', description: 'first', inputSchema: {} },
        { name: 'echo', description: 'second', inputSchema: {} },
        { name: 'unique', inputSchema: {} },
      ] };
    },
    async listResources() {
      return { items: [{ uri: 'file:///a' }, { uri: 'file:///a' }] };
    },
  });

  assert.equal(s.tools.length, 3, 'every item is still captured');
  // Their items carry no inputSchema, which phase 10 reports as malformed; this test is about duplicates.
  const reported = s.problems.filter((p) => p.kind !== 'malformed').map((p) => `${p.endpoint}: ${p.message}`).sort();
  assert.equal(reported.length, 2, `expected one problem per affected list, got ${JSON.stringify(reported)}`);
  assert.match(reported[0], /duplicate/i);
  assert.match(reported.join(' '), /echo/);
  assert.match(reported.join(' '), /file:\/\/\/a/);
});

test('unique names produce no duplicate report (old valid input)', async () => {
  const s = await captureSurface({
    revision: '2026-07-28', era: 'modern', capabilities: {},
    async listTools() { return { items: [{ name: 'a', inputSchema: {} }, { name: 'b', inputSchema: {} }] }; },
  });
  assert.deepEqual(s.problems.filter((p) => p.kind !== 'malformed'), []);
  assert.equal(s.tools.length, 2);
});

test('a programming error is not reported as the server-s fault', async () => {
  // collectOrRecord exists to survive a broken ENDPOINT. A TypeError from our
  // own code is not that: recording it would blame the server, silently drop
  // the list, and move the surface hash -- writing a spurious version into the
  // history because of our bug.
  await assert.rejects(
    () => captureSurface({
      revision: '2026-07-28', era: 'modern', capabilities: {},
      async listTools() { throw new TypeError("Cannot read properties of undefined (reading 'tools')"); },
    }),
    (e) => e instanceof TypeError,
  );
});

test('a server-side failure is still recorded, not thrown (old valid input)', async () => {
  const s = await captureSurface({
    revision: '2026-07-28', era: 'modern', capabilities: {},
    async listTools() { return { items: [{ name: 'a', inputSchema: {} }] }; },
    async listPrompts() { throw new Error('Method not found: prompts/list'); },
  });
  assert.equal(s.tools.length, 1);
  assert.deepEqual(s.problems.filter((p) => p.kind !== 'malformed').map((p) => p.endpoint), ['prompts/list']);
});
