// The surface views' pure logic (round 5): board 5.4's four states, and the
// readable pane's parameters, arguments and annotations. Imported as
// TypeScript directly; Node strips the types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listState, listLabel, fieldState, parameters, promptArguments, annotationRows, entryKey, ANNOTATIONS_LINE,
} from '../app/renderer/src/lib/surface.ts';

const surface = (extra = {}) => ({
  revision: '2025-06-18', era: 'legacy', capabilities: { tools: {} }, tools: [], prompts: [], resources: [], resourceTemplates: [],
  unavailable: [], problems: [], ...extra,
});

test('board 5.4: not advertised, failed, empty and listed are four different states', () => {
  const s = surface({ tools: [{ name: 'a' }], capabilities: { tools: {}, prompts: {}, resources: {} }, problems: [{ endpoint: 'resources/list', message: 'boom' }] });
  assert.deepEqual(listState(surface(), 'prompts'), { kind: 'not-advertised' });
  assert.deepEqual(listState(s, 'prompts'), { kind: 'empty' });
  assert.deepEqual(listState(s, 'tools'), { kind: 'items', count: 1 });
  assert.deepEqual(listState(s, 'resources'), { kind: 'failed', message: 'boom' });
  assert.deepEqual(listState(s, 'resourceTemplates'), { kind: 'empty' }, 'templates share the resources capability, not its list failure');
  assert.deepEqual([listLabel('Prompts', { kind: 'empty' }), listLabel('Prompts', { kind: 'not-advertised' })], ['Prompts 0', 'Prompts: not advertised']);
});

test('a duplicate-name problem does not make a list read as failed', () => {
  const s = surface({ tools: [{ name: 'a' }, { name: 'a' }], problems: [{ endpoint: 'tools/list', message: 'duplicate identity key(s): a -- only one of each survives hashing and diffing' }] });
  assert.deepEqual(listState(s, 'tools'), { kind: 'items', count: 2 });
});

test('a field the revision cannot carry is never "none sent", and one removed later says when', () => {
  assert.deepEqual(fieldState('tool', 'annotations', {}, '2024-11-05'), { kind: 'not-on-revision', label: 'not on 2024-11-05 (added in 2025-03-26)' });
  assert.deepEqual(fieldState('tool', 'icons', {}, '2025-06-18'), { kind: 'not-on-revision', label: 'not on 2025-06-18 (added in 2025-11-25)' });
  assert.deepEqual(fieldState('tool', 'execution', {}, '2026-07-28'), { kind: 'not-on-revision', label: 'not on 2026-07-28 (removed in 2026-07-28)' });
  assert.deepEqual(fieldState('tool', 'annotations', {}, '2025-06-18'), { kind: 'none-sent' });
  assert.deepEqual(fieldState('tool', 'title', { title: 'T' }, '2025-06-18'), { kind: 'value', value: 'T' });
  assert.deepEqual(fieldState('tool', 'description', {}, '2024-11-05'), { kind: 'none-sent' }, 'a field with no window exists on every revision');
});

test('parameters come from properties, with required, types and descriptions; anything else has none', () => {
  assert.deepEqual(parameters({ type: 'object', properties: {
    text: { type: 'string', description: 'What to echo.' },
    n: { type: ['integer', 'null'] },
    mode: { type: 'string', enum: ['a', 'b'] },
    choice: { oneOf: [{}, {}, {}] },
    anything: {},
  }, required: ['text', 'missing'] }), [
    { name: 'text', type: 'string', required: true, description: 'What to echo.' },
    { name: 'n', type: 'integer | null', required: false },
    { name: 'mode', type: 'string, one of 2', required: false },
    { name: 'choice', type: 'oneOf (3)', required: false },
    { name: 'anything', type: 'any', required: false },
  ]);
  for (const odd of [undefined, null, 'x', { type: 'object' }, { properties: [] }]) assert.equal(parameters(odd), undefined);
});

test('prompt arguments: none sent is an empty list; a malformed one is not guessed at', () => {
  assert.deepEqual(promptArguments(undefined), []);
  assert.deepEqual(promptArguments([{ name: 'who', required: true }, { name: 'tone', description: 'How.' }]), [
    { name: 'who', required: true }, { name: 'tone', required: false, description: 'How.' },
  ]);
  assert.equal(promptArguments([{ required: true }]), undefined);
  assert.equal(promptArguments('who'), undefined);
});

test('annotations are listed as the server sent them, and the line says they are not trusted', () => {
  assert.deepEqual(annotationRows({ readOnlyHint: true, title: 'x' }), [['readOnlyHint', 'true'], ['title', '"x"']]);
  assert.equal(annotationRows(undefined), undefined);
  assert.match(ANNOTATIONS_LINE, /does not trust them/);
});

test('entries are keyed by name, uri or uriTemplate', () => {
  assert.equal(entryKey('tools', { name: 'a' }), 'a');
  assert.equal(entryKey('resources', { uri: 'file:///x', name: 'n' }), 'file:///x');
  assert.equal(entryKey('resourceTemplates', { uriTemplate: 'x/{y}' }), 'x/{y}');
});

test('worst offenders are the first n, each with its share of the total', async () => {
  const { worstOffenders } = await import('../app/renderer/src/lib/contextView.ts');
  const cost = { total: 200, tools: [{ serverId: 'a', name: 'x', tokens: 150 }, { serverId: 'a', name: 'y', tokens: 30 }, { serverId: 'b', name: 'z', tokens: 20 }] };
  assert.deepEqual(worstOffenders(cost, 2).map((t) => [t.name, t.share]), [['x', '75.0%'], ['y', '15.0%']]);
  assert.equal(worstOffenders({ total: 0, tools: [{ serverId: 'a', name: 'x', tokens: 0 }] }, 5)[0].share, '');
});
