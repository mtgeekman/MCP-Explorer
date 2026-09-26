// Comparing two versions of a server (plan phase 09): the golden pairs, both
// structured and rendered, and the acceptance criteria against the fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareVersions, hashSurface, surfaceChangeCount, O200K } from '../packages/protocol/dist/index.js';
import { PAIRS, SERVER_NAME, capturePair } from './golden/version-pairs.mjs';

const dir = new URL('./golden/versions/', import.meta.url);
const read = (file) => readFileSync(fileURLToPath(new URL(file, dir)), 'utf8');
const stored = (name) => JSON.parse(read(`${name}.json`));
const compare = (before, after, extra = {}) => compareVersions(before, after, { name: SERVER_NAME, tokenizer: O200K, ...extra });

for (const name of Object.keys(PAIRS)) {
  test(`golden pair ${name}: the comparison matches byte for byte`, () => {
    const { before, after } = stored(name);
    assert.equal(`${JSON.stringify(compare(before, after), null, 2)}\n`, read(`${name}.expected.json`));
  });

  test(`golden pair ${name}: the stored surfaces are what the fixture captures today`, async () => {
    // Otherwise the goldens pin a fixture that no longer exists.
    const live = await capturePair(PAIRS[name]);
    const { before, after } = stored(name);
    assert.equal(hashSurface(live.before), hashSurface(before));
    assert.equal(hashSurface(live.after), hashSurface(after));
  });
}

test('acceptance: one changed description is exactly one changed item, with the right token delta', () => {
  const { before, after } = stored('modern-description');
  const c = compare(before, after);
  assert.equal(surfaceChangeCount(c.structured), 1);
  assert.deepEqual(c.structured.tools.map((t) => [t.key, t.kind, t.fields.map((f) => f.path)]), [['echo', 'changed', ['/description']]]);
  // Counted here without the cost code: the tool entry as the block holds it.
  const entry = (s) => { const t = s.tools.find((x) => x.name === 'echo'); return JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema }); };
  const expected = O200K.count(entry(after)) - O200K.count(entry(before));
  assert.ok(expected !== 0, 'precondition: the description change costs tokens');
  assert.equal(c.tokens.delta, expected);
  assert.deepEqual(c.tokens.tools.map((t) => [t.name, t.delta]), [['echo', expected]]);
  assert.equal(c.tokens.after - c.tokens.before, c.tokens.delta);
  assert.equal(c.model.diff.removed, 1);
  assert.equal(c.model.diff.added, 1);
});

test('acceptance: a version bump alone is "version changed, surface identical"', () => {
  const { before, after } = stored('modern-server-version');
  assert.notEqual(hashSurface(before), hashSurface(after), 'a version bump is its own snapshot (D8)');
  const c = compare(before, after);
  assert.deepEqual(c.structured.identityChanged, [{ field: 'serverVersion', from: '1.0.0', to: '1.0.1' }]);
  assert.equal(surfaceChangeCount(c.structured), 0);
  assert.deepEqual(c.model.diff.hunks, [], 'nothing the model sees changed');
  assert.equal(c.tokens.delta, 0);
  assert.equal(c.raw.diff.hunks.length, 1, 'the stored snapshot does differ: its version');
});

test('past the edit limit both texts are still there to show whole', () => {
  const { before, after } = stored('modern-description');
  assert.equal(compare(before, after, { maxEdits: 2 }).model.diff.complete, true, 'one line out and one in is two edits');
  assert.equal(compare(before, after, { maxEdits: 1 }).model.diff.complete, false);
  const tight = compare(before, { ...after, tools: [] }, { maxEdits: 3 });
  assert.equal(tight.model.diff.complete, false);
  assert.ok(tight.model.before.length > 0 && tight.model.after.length > 0);
});

test('tools added and removed carry their whole cost, largest change first', () => {
  const { before } = stored('modern-description');
  const extra = { name: 'zzz_new', description: 'x '.repeat(40), inputSchema: { type: 'object' } };
  const after = { ...before, tools: [...before.tools.filter((t) => t.name !== 'needs_input'), extra] };
  const c = compare(before, after);
  const kinds = c.tokens.tools.map((t) => [t.name, t.kind]);
  assert.deepEqual(kinds, [['zzz_new', 'added'], ['needs_input', 'removed']]);
  const removed = c.tokens.tools[1];
  assert.equal(removed.after, undefined);
  assert.equal(removed.delta, -removed.before);
  assert.equal(c.tokens.delta, c.tokens.tools.reduce((n, t) => n + t.delta, 0));
});
