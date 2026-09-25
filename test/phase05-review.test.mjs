// Phase 05 code review, round 1: one test per confirmed finding, written
// before the fixes. Findings are numbered as the review reported them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../packages/backend/dist/index.js';
import { mergePicked, redactRaw } from '../app/renderer/src/lib/importReview.ts';

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
  const shown = redactRaw(raw, { API_KEY: 'sk-live-1', MODE: 'dev' }, ['API_KEY']);
  assert.ok(!shown.includes('sk-live-1'), shown);
  assert.ok(shown.includes('"MODE": "dev"'));
  assert.equal(redactRaw(raw, { API_KEY: 'sk-live-1' }, []), raw, 'nothing marked, nothing changed');
  // A value that needs escaping in JSON is still found.
  const quoted = JSON.stringify({ env: { K: 'a"b\c' } }, null, 2);
  assert.ok(!redactRaw(quoted, { K: 'a"b\c' }, ['K']).includes('a\\"b'));
});
