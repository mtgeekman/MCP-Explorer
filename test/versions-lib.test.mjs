// The version views' pure logic (plan phase 09, board 7). Imported as
// TypeScript directly; Node strips the types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  entryText, unstableLine, span, defaultBase, hunkHeader, segments, fieldRows, formatValue, tokenLine, toolTokenCells,
} from '../app/renderer/src/lib/versions.ts';

const entry = (o) => ({ index: 0, snapshotId: 1, kind: 'first', version: 1, underVersion: 1, changes: 0, revision: '2025-11-25', era: 'legacy', serverVersion: '1.0.0', firstObservedAt: 0, lastObservedAt: 0, observations: 1, ...o });
const entries = [
  entry({}),
  entry({ index: 1, kind: 'identity', version: null, underVersion: 1, serverVersion: '1.0.1', observations: 3 }),
  entry({ index: 2, kind: 'surface', version: 2, underVersion: 2, changes: 1, serverVersion: '1.0.1' }),
  entry({ index: 3, kind: 'revision', version: 3, underVersion: 3, revision: '2026-07-28', serverVersion: '1.0.1' }),
  entry({ index: 4, kind: 'surface', version: 4, underVersion: 4, changes: 2, revision: '2025-11-25', sameAs: 0, serverVersion: '1.0.0' }),
  entry({ index: 5, kind: 'identity', version: null, underVersion: 4, serverName: 'renamed', serverVersion: '1.0.0' }),
  entry({ index: 6, kind: 'surface', version: 5, underVersion: 5, changes: 0 }),
  entry({ index: 7, kind: 'identity', version: null, underVersion: 5, sameAs: 1, serverVersion: '1.0.1' }),
];

test('each kind of entry says what it is (board 7.2)', () => {
  const t = (i) => entryText(entries, i);
  assert.deepEqual(t(0), { title: 'Version 1', detail: 'First capture, revision 2025-11-25', captures: '1 capture' });
  assert.deepEqual(t(1), { title: 'Identity only', detail: 'Version changed, surface identical: version 1.0.0 to 1.0.1', captures: '3 captures' });
  assert.equal(t(2).detail, '1 change');
  assert.equal(t(3).detail, 'Revision changed, surface identical: 2025-11-25 to 2026-07-28');
  assert.equal(t(4).detail, '2 changes, and revision 2026-07-28 to 2025-11-25');
  assert.equal(t(4).sameAs, 'Same as version 1');
  assert.equal(t(5).detail, 'Server identity changed, surface identical: name (none) to renamed');
  assert.match(t(6).detail, /cannot name/);
  assert.equal(t(7).sameAs, 'Same as the identity entry under version 1');
});

test('the unstable line, and spans of time in words', () => {
  assert.equal(unstableLine({ entries: [] }), null);
  assert.equal(unstableLine({ entries: [], unstable: { entries: 12, since: 0, until: 2 * 86_400_000 } }),
    'Unstable: the last 12 captures each produced a different version, over 2 days.');
  assert.deepEqual([span(999), span(1000), span(59_000), span(60_000), span(3_600_000), span(90 * 60_000), span(86_400_000)],
    ['1 second', '1 second', '59 seconds', '1 minute', '1 hour', '2 hours', '1 day']);
});

test('an entry opens against the one before it; the first against none', () => {
  assert.equal(defaultBase(0), null);
  assert.equal(defaultBase(3), 2);
});

test('hunk headers and marked spans', () => {
  assert.equal(hunkHeader({ beforeStart: 3, beforeCount: 7, afterStart: 3, afterCount: 8 }), '@@ -3,7 +3,8 @@');
  assert.deepEqual(segments({ op: 'added', text: 'abcdef', mark: [2, 4] }), [
    { text: 'ab', marked: false }, { text: 'cd', marked: true }, { text: 'ef', marked: false },
  ]);
  assert.deepEqual(segments({ op: 'removed', text: 'abc', mark: [3, 3] }), [{ text: 'abc', marked: false }], 'an empty mark marks nothing');
  assert.deepEqual(segments({ op: 'added', text: 'abc', mark: [0, 3] }), [{ text: 'abc', marked: true }]);
  assert.deepEqual(segments({ op: 'same', text: '' }), [{ text: '', marked: false }]);
});

test('By item: every difference is a row, down to the field', () => {
  const rows = fieldRows({
    identical: false,
    revisionChanged: { from: '2025-11-25', to: '2026-07-28' },
    identityChanged: [{ field: 'serverVersion', from: '1', to: '2' }],
    instructionsChanged: true, instructions: { after: 'New.' },
    capabilitiesChanged: true, capabilityChanges: [{ path: '', kind: 'changed', before: null, after: { tools: {} } }],
    tools: [
      { key: 'a', kind: 'added' },
      { key: 'b', kind: 'changed', fields: [{ path: '/description', kind: 'changed', before: 'x', after: 'y' }, { path: '/inputSchema/required/0', kind: 'removed', before: 'q' }] },
    ],
    prompts: [], resources: [{ key: 'file:///r', kind: 'removed' }], resourceTemplates: [],
  });
  assert.deepEqual(rows, [
    { group: 'Revision', key: '', kind: 'changed', before: '2025-11-25', after: '2026-07-28' },
    { group: 'Identity', key: 'serverVersion', kind: 'changed', before: '1', after: '2' },
    { group: 'Instructions', key: '', kind: 'added', after: 'New.' },
    { group: 'Capabilities', key: '', kind: 'changed', path: '(whole value)', before: 'null', after: '{"tools":{}}' },
    { group: 'Tools', key: 'a', kind: 'added' },
    { group: 'Tools', key: 'b', kind: 'changed', path: '/description', before: 'x', after: 'y' },
    { group: 'Tools', key: 'b', kind: 'removed', path: '/inputSchema/required/0', before: 'q' },
    { group: 'Resources', key: 'file:///r', kind: 'removed' },
  ]);
  assert.deepEqual([formatValue(undefined), formatValue('s'), formatValue(0), formatValue(false)], [undefined, 's', '0', 'false']);
});

test('the token line and table', () => {
  const t = (o) => ({ tokenizer: { id: 'o200k_base', label: 'L' }, before: 91, after: 94, delta: 3, instructions: { before: 0, after: 0 }, tools: [], ...o });
  assert.equal(tokenLine(t()), '+3 tokens (91 to 94, o200k_base)');
  assert.equal(tokenLine(t({ after: 88, delta: -3 })), '-3 tokens (91 to 88, o200k_base)');
  assert.equal(tokenLine(t({ after: 91, delta: 0 })), 'No token change (91 o200k_base tokens)');
  assert.deepEqual(toolTokenCells({ name: 'a', kind: 'added', after: 10, delta: 10 }), ['a', 'added, 10', '+10']);
  assert.deepEqual(toolTokenCells({ name: 'b', kind: 'removed', before: 7, delta: -7 }), ['b', 'removed, was 7', '-7']);
  assert.deepEqual(toolTokenCells({ name: 'c', kind: 'changed', before: 7, after: 9, delta: 2 }), ['c', '7 to 9', '+2']);
});
