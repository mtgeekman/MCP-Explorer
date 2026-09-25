// Config import (phase 05): each client's file becomes draft servers for the
// review, entries it cannot import faithfully are disabled with a reason,
// dropped fields are listed, and no variable is filled from the environment.
// The samples in test/config-samples/ follow each client's documented format
// (researched 2026-09-25; see the plan page's Phase 05 section).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseConfig, looksSecret } from '../packages/backend/dist/index.js';

const sample = (name) => readFileSync(new URL(`./config-samples/${name}`, import.meta.url), 'utf8');
const source = (client, format, extra = {}) => ({ client, format, home: '/home/me', sep: '/', ...extra });
const byName = (parsed) => Object.fromEntries(parsed.entries.map((e) => [e.name, e]));

test('Claude Desktop: local servers import as written, and a url entry is refused as Desktop itself would', () => {
  const parsed = parseConfig(sample('claude_desktop_config.json'), source('claude-desktop', 'mcpServers'));
  assert.deepEqual(parsed.problems, []);
  const e = byName(parsed);
  assert.deepEqual(e.filesystem.server, {
    name: 'filesystem', transport: 'stdio', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me\\Desktop'],
    env: {}, headers: {}, askFor: { env: [], headers: [] }, suggestedSecrets: { env: [], headers: [] },
  });
  // Desktop expands no variables, so ${HOME} is a literal value, not a placeholder.
  assert.deepEqual(e.github.server.env, { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_example', LOG_LEVEL: 'info', HOME_DIR: '${HOME}' });
  assert.deepEqual(e.github.server.suggestedSecrets, { env: ['GITHUB_PERSONAL_ACCESS_TOKEN'], headers: [] });
  assert.match(e.remote.disabled, /Claude Desktop runs only local commands/);
  assert.equal(e.remote.server, undefined);
});

test('Claude Code ~/.claude.json: the user scope and every project scope, each entry knowing its project', () => {
  const parsed = parseConfig(sample('claude.json'), source('claude-code', 'claude-code-user'));
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.entries.map((x) => [x.location, x.name]), [
    ['mcpServers', 'sentry'], ['mcpServers', 'legacy-events'], ['mcpServers', 'sockets'], ['mcpServers', 'no-type'],
    ['projects["/home/me/src/app"].mcpServers', 'db'], ['projects["/home/me/src/app"].mcpServers', 'local-api'],
  ]);
  const e = byName(parsed);
  assert.equal(e.sentry.server.transport, 'streamable-http');
  assert.equal(e['legacy-events'].server.transport, 'sse');
  assert.deepEqual(e['legacy-events'].dropped, ["timeout: the client's own timeout"]);
  assert.match(e.sockets.disabled, /WebSocket/);
  assert.match(e['no-type'].disabled, /Claude Code refuses a url without a "type"/);
  assert.equal(e.db.projectRoot, '/home/me/src/app');
});

test('decision 9: an environment reference in a header or env value is asked for at connect, never filled', () => {
  process.env.SENTRY_TOKEN = 'from-the-app-environment';
  try {
    const e = byName(parseConfig(sample('claude.json'), source('claude-code', 'claude-code-user')));
    assert.deepEqual(e.sentry.server.headers, {});
    assert.deepEqual(e.sentry.server.askFor, { env: [], headers: ['Authorization'] });
    assert.ok(!JSON.stringify(e.sentry).includes('from-the-app-environment'), 'a value was filled from the environment');
    assert.match(e.sentry.notes[0], /Header Authorization comes from \$\{SENTRY_TOKEN\}/);
    // A default is still an environment reference: asked for, not assumed.
    assert.deepEqual(e['local-api'].server.env, { MODE: 'local' });
    assert.deepEqual(e['local-api'].server.askFor.env, ['API_KEY']);
  } finally {
    delete process.env.SENTRY_TOKEN;
  }
});

test('decision 9: a reference the app will not fill, in a command or argument, disables the entry', () => {
  const e = byName(parseConfig(sample('claude.json'), source('claude-code', 'claude-code-user')));
  assert.equal(e.db.disabled, 'Argument 3 uses ${DB_PORT:-5432}, which the app does not fill in.');
  const v = byName(parseConfig(sample('vscode-mcp.json'), source('vscode', 'vscode', { projectRoot: '/src/app' })));
  assert.equal(v.configured.disabled, 'Argument 1 uses ${config:mcp.serverPath}, which the app does not fill in.');
});

test('Claude Code .mcp.json: the project directory is filled in, and a headers command is dropped by name', () => {
  const parsed = parseConfig(sample('dot-mcp.json'), source('claude-code', 'mcpServers', { projectRoot: '/src/app' }));
  const e = byName(parsed);
  assert.deepEqual(e.everything.server.args, ['-y', '@modelcontextprotocol/server-everything']);
  assert.deepEqual(e.helper.dropped, ['headersHelper: a command that produces headers; it is not run, so add the headers by hand or as secrets']);
  assert.equal(e.helper.server.url, 'https://example.com/mcp');
  const claude = parseConfig('{"mcpServers":{"s":{"command":"node","args":["${CLAUDE_PROJECT_DIR}/s.js"]}}}', source('claude-code', 'mcpServers', { projectRoot: '/src/app' }));
  assert.deepEqual(claude.entries[0].server.args, ['/src/app/s.js']);
});

test('VS Code mcp.json: comments and trailing commas parse; predefined variables fill; inputs are asked for', () => {
  const parsed = parseConfig(sample('vscode-mcp.json'), source('vscode', 'vscode', { projectRoot: '/src/app' }));
  assert.deepEqual(parsed.problems, []);
  const e = byName(parsed);
  assert.deepEqual(e.memory.server.args, ['-y', '@modelcontextprotocol/server-memory', '/src/app/memory.json']);
  assert.deepEqual(e.memory.server.env, { DEBUG: '1' });
  assert.deepEqual(e.memory.server.askFor.env, ['GITHUB_TOKEN']);
  assert.deepEqual(e.memory.dropped, ['envFile: an environment file; its variables are not read, so add any the server needs by hand']);
  assert.equal(e.github.server.transport, 'streamable-http');
  assert.deepEqual(e.github.server.headers, { 'X-Client': 'vscode' });
  assert.equal(e.inferred.server.transport, 'streamable-http', 'VS Code infers a remote server from its url');
});

test('${workspaceFolder} with no project is not guessed: the entry is disabled', () => {
  const parsed = parseConfig(sample('vscode-mcp.json'), source('vscode', 'vscode'));
  assert.match(byName(parsed).memory.disabled, /\$\{workspaceFolder\}/);
});

test('Cursor: ${userHome} fills, ${env:} is asked for, plain credentials are pre-marked, OAuth is dropped', () => {
  const parsed = parseConfig(sample('cursor-mcp.json'), source('cursor', 'mcpServers'));
  const e = byName(parsed);
  assert.deepEqual(e.notes.server.args, ['/home/me/notes-mcp/index.js']);
  assert.deepEqual(e.notes.server.askFor.env, ['NOTES_API_KEY']);
  assert.deepEqual(e.notes.server.env, { NOTES_PASSWORD: 'hunter2' });
  assert.deepEqual(e.notes.server.suggestedSecrets.env, ['NOTES_PASSWORD']);
  assert.deepEqual(e.remote.server.suggestedSecrets.headers, ['Authorization']);
  assert.deepEqual(e.remote.dropped, ['auth: OAuth settings; OAuth is not supported yet']);
});

test('malformed entries are disabled one by one with a reason, and the rest still import', () => {
  const e = byName(parseConfig(sample('cursor-mcp.json'), source('cursor', 'mcpServers')));
  assert.match(e.both.disabled, /both a command and a url/);
  assert.match(e['bad-args'].disabled, /"args" is not a list of text values/);
  assert.match(e['not-an-object'].disabled, /not an object/);
  assert.equal(e['not-an-object'].raw, '"node server.js"');
  assert.ok(e.notes.server && e.remote.server);
});

test('a corrupt file is one problem with its position, and no entries', () => {
  const parsed = parseConfig(sample('corrupt.json'), source('cursor', 'mcpServers'));
  assert.deepEqual(parsed.entries, []);
  assert.equal(parsed.problems.length, 1);
  assert.match(parsed.problems[0], /^The file is not valid JSON: comma expected at line 4, column 5\.$/);
});

test('files that are not objects, have no servers, or have servers of the wrong shape say so', () => {
  const cc = source('claude-code', 'mcpServers');
  assert.deepEqual(parseConfig('[]', cc).problems, ['The file does not hold a JSON object.']);
  assert.deepEqual(parseConfig('', cc).problems.length, 1);
  assert.deepEqual(parseConfig('{}', cc), { entries: [], problems: [] });
  assert.deepEqual(parseConfig('{"mcpServers": []}', cc).problems, ['mcpServers is not an object of servers.']);
  assert.deepEqual(parseConfig('{"projects": 3}', source('claude-code', 'claude-code-user')).problems, ['projects is not an object.']);
});

test('VS Code settings.json before 1.102, and devcontainer.json, are read from where they nest', () => {
  const s = parseConfig(sample('vscode-settings.json'), source('vscode', 'vscode-settings'));
  assert.deepEqual(s.entries.map((x) => [x.location, x.server.command, x.server.args]), [['mcp.servers', 'uvx', ['mcp-server-time']]]);
  const d = parseConfig(sample('devcontainer.json'), source('vscode', 'devcontainer', { projectRoot: '/workspaces/app' }));
  assert.deepEqual(d.entries.map((x) => [x.location, x.server.cwd]), [['customizations.vscode.mcp.servers', '/workspaces/app']]);
});

test('fields for the other kind of server are dropped with why, and unknown ones are named', () => {
  const parsed = parseConfig('{"mcpServers":{"s":{"command":"node","headers":{"A":"b"},"autoApprove":["x"]}}}', source('cursor', 'mcpServers'));
  assert.deepEqual(parsed.entries[0].dropped, ['headers: has no effect on a local server', 'autoApprove: not something this app uses']);
});

test('looksSecret: credential-looking names are pre-marked; ordinary ones are not', () => {
  for (const n of ['API_KEY', 'GITHUB_TOKEN', 'Authorization', 'DB_PASSWORD', 'DB_PASSWD', 'CLIENT_SECRET', 'AWS_CREDENTIALS', 'X-Api-Key']) assert.ok(looksSecret(n), n);
  for (const n of ['LOG_LEVEL', 'PORT', 'MODE', 'X-Client', 'HOME_DIR']) assert.ok(!looksSecret(n), n);
});
