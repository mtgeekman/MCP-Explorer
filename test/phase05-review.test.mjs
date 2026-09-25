// Phase 05 code review, round 1: one test per confirmed finding, written
// before the fixes. Findings are numbered as the review reported them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../packages/backend/dist/index.js';
import { hiddenValues, mergePicked, redactRaw } from '../app/renderer/src/lib/importReview.ts';

const cc = (projectRoot) => ({ client: 'claude-code', format: 'mcpServers', home: '/home/me', sep: '/', projectRoot });

test('R05-1: a VS Code variable in a .mcp.json is never passed through as literal text', () => {
  const text = JSON.stringify({ mcpServers: {
    args: { command: 'node', args: ['${workspaceFolder}/server.js'] },
    env: { command: 'node', env: { TOKEN: '${input:tok}', OTHER: '${env:OTHER}' } },
    ok: { command: 'node', args: ['${CLAUDE_PROJECT_DIR}/s.js', '$HOME'] },
  } });
  const e = Object.fromEntries(parseConfig(text, cc('/src/app')).entries.map((x) => [x.name, x]));
  assert.match(e.args.disabled ?? '', /\$\{workspaceFolder\}/, 'a literal ${workspaceFolder} would reach the server');
  assert.deepEqual(e.env.server.env, {});
  assert.deepEqual(e.env.server.askFor.env, ['TOKEN', 'OTHER']);
  // Old valid input: the Claude Code project variable still fills, and a bare $HOME is not a placeholder.
  assert.deepEqual(e.ok.server.args, ['/src/app/s.js', '$HOME']);
});

test('R05-3: adding a project folder keeps what the user unticked, and ticks only newly found files', () => {
  const before = [{ path: '/a', found: true }, { path: '/b', found: true }];
  const picked = new Set(['/b']);
  const after = [...before, { path: '/p/.mcp.json', found: true }, { path: '/p/.cursor/mcp.json', found: false }];
  assert.deepEqual([...mergePicked(picked, before, after)].sort(), ['/b', '/p/.mcp.json']);
  // First listing: nothing was known before, so every found file starts ticked.
  assert.deepEqual([...mergePicked(new Set(), null, before)].sort(), ['/a', '/b']);
});

test('R05-4: the entry as written hides every value the user marked secret', () => {
  const raw = JSON.stringify({ command: 'node', env: { API_KEY: 'sk-live-1', MODE: 'dev' } }, null, 2);
  const shown = redactRaw(raw, ['sk-live-1']);
  assert.ok(!shown.includes('sk-live-1'), shown);
  assert.ok(shown.includes('"MODE": "dev"'));
  assert.equal(redactRaw(raw, []), raw, 'nothing marked, nothing changed');
});

// --- round 2: the re-review of the fix chain ---------------------------------------------

test('R05-11: Claude Code\'s ${CLAUDE_PROJECT_DIR:-default} is still filled from the project', () => {
  const text = JSON.stringify({ mcpServers: { s: { command: 'node', args: ['${CLAUDE_PROJECT_DIR:-.}/s.js'] } } });
  const [entry] = parseConfig(text, cc('/src/app')).entries;
  assert.equal(entry.disabled, undefined, entry.disabled);
  assert.deepEqual(entry.server.args, ['/src/app/s.js']);
  // With no project there is nothing certain to fill it with; the default is not assumed.
  assert.match(parseConfig(text, cc(undefined)).entries[0].disabled, /CLAUDE_PROJECT_DIR/);
  // Other clients have no such variable: a VS Code file with it is refused, not filled.
  assert.match(parseConfig(text, { ...cc('/src/app'), client: 'cursor' }).entries[0].disabled, /CLAUDE_PROJECT_DIR/);
});

test('R05-12: a disabled entry reports its credential-looking values, so its raw view can hide them', () => {
  const text = JSON.stringify({ mcpServers: { s: { command: 'node', args: ['${workspaceFolder}/x.js'], env: { API_KEY: 'sk-live-9', MODE: 'dev' }, headers: { Authorization: 'Bearer z' } } } });
  const [entry] = parseConfig(text, cc(undefined)).entries;
  assert.ok(entry.disabled);
  assert.deepEqual(entry.sensitive, ['sk-live-9', 'Bearer z']);
  assert.ok(!redactRaw(entry.raw, entry.sensitive).includes('sk-live-9'));
});

test('R05-13: redaction finds a value with a backslash and a quote', () => {
  const value = String.raw`a"b\c`;
  const raw = JSON.stringify({ env: { K: value } }, null, 2);
  assert.ok(raw.includes(String.raw`a\"b\\c`), 'the sample must hold both escapes');
  assert.ok(!redactRaw(raw, [value]).includes(String.raw`a\"b\\c`));
});

test('R05-14: the raw view hides marked values of an importable entry, and credential-looking ones of a disabled entry', () => {
  const server = { name: 's', transport: 'stdio', command: 'node', env: { API_KEY: 'k1', MODE: 'dev' }, headers: {}, askFor: { env: [], headers: [] }, suggestedSecrets: { env: ['API_KEY'], headers: [] } };
  const importable = { name: 's', location: 'mcpServers', dropped: [], notes: [], raw: '{}', sensitive: ['k1'], server };
  assert.deepEqual(hiddenValues(importable, { keep: true, name: 's', onClash: 'skip', secretEnv: ['API_KEY'], secretHeaders: [] }), ['k1']);
  // Unmarked by the user: shown, as the table shows it.
  assert.deepEqual(hiddenValues(importable, { keep: true, name: 's', onClash: 'skip', secretEnv: [], secretHeaders: [] }), []);
  const disabled = { name: 'd', location: 'mcpServers', dropped: [], notes: [], raw: '{}', sensitive: ['k2'], disabled: 'no' };
  assert.deepEqual(hiddenValues(disabled, undefined), ['k2']);
});
