// Phase 04 to 09 acceptance, driven through the real app with playwright-core. Run
// with `npm run test:smoke` after `npm run build`; it needs a display (CI
// runs it under xvfb on Linux). Set MCPX_APP_EXE to drive a packaged build
// instead of the built tree.
//
// Not part of `npm test`: the unit suite must never depend on a window.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { addToRegistry, createWorkspaceDb, saveServer, openWorkspaceDb, recordCapture } from '../../packages/storage/dist/index.js';
import { connectStdio, captureSurface } from '../../packages/protocol/dist/index.js';
import { isAlive, killProcessTree } from '../../packages/platform/dist/index.js';
import { fixtures, listen } from '../support/fixture-servers.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// No trailing separator: on Windows a backslash before the closing quote of an
// argument escapes the quote, and Electron is handed a mangled path.
const repo = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'mcpx-smoke-'));
const children = [];
after(() => {
  for (const c of children) c.kill();
  rmSync(work, { recursive: true, force: true });
});

const noSecrets = { get: () => null, set: () => { throw new Error('the smoke tests use unencrypted workspaces'); }, delete: () => false };
const modern = join(fixtures, 'modern-server.mjs');
const legacy = join(fixtures, 'legacy-server.mjs');
const win = process.platform === 'win32';

/** A data directory holding one unencrypted workspace with these servers, as the app would have left it. */
function seed(servers, captures = []) {
  const dataDir = mkdtempSync(join(work, 'data-'));
  const id = randomUUID();
  const path = join(dataDir, `${id}.db`);
  const ws = createWorkspaceDb({ path, workspaceId: id, name: 'Smoke', custody: { kind: 'none' }, secrets: noSecrets });
  for (const s of servers) saveServer(ws, s);
  // Earlier captures, as earlier sessions would have left them (phase 09): [serverId, surface, at].
  for (const [serverId, surface, at] of captures) recordCapture(ws, serverId, surface, { now: () => at });
  ws.close();
  addToRegistry(join(dataDir, 'workspaces.json'), { id, path, custody: 'none', createdAt: Date.now(), name: 'Smoke' });
  return { dataDir, path, id };
}

async function launch(dataDir) {
  // Electron refuses to run as root without --no-sandbox, which is how the CI container runs.
  const sandbox = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
  const app = await electron.launch(process.env.MCPX_APP_EXE
    ? { executablePath: process.env.MCPX_APP_EXE, args: sandbox, env: { ...process.env, MCPX_DATA_DIR: dataDir } }
    : { args: [repo, ...sandbox], env: { ...process.env, MCPX_DATA_DIR: dataDir } });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 });
  return { app, page };
}

async function openWorkspace(page) {
  await page.getByText('Smoke').first().click();
  await page.locator('.server-list').waitFor();
}

async function connect(page, name, expect = /Connected, (modern|legacy) era/) {
  await page.locator('.server-row', { hasText: name }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.state-card h3', { hasText: expect }).waitFor({ timeout: 20_000 });
  return page.locator('.state-card h3').innerText();
}

async function disconnect(page) {
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.locator('.state-card h3', { hasText: 'Stopped' }).waitFor({ timeout: 20_000 });
}

const spawnLog = () => {
  const p = join(work, `${randomUUID()}.spawns`);
  writeFileSync(p, '');
  return p;
};
const pids = (log) => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => Number(/pid=(\d+)/.exec(l)[1]));

async function gone(pid, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/** A stdio server behind a shell that stays its parent: the npx shape (cmd.exe over node) and its POSIX twin. */
function wrapped(script, env) {
  return win
    ? { command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/c', process.execPath, script], env }
    : { command: '/bin/sh', args: ['-c', `"${process.execPath}" "${script}"; exit $?`], env };
}

test('both eras connect over all three transports from the GUI, and every unit shown is stored', async () => {
  const servers = [
    { id: randomUUID(), name: 'stdio modern', transport: 'stdio', command: process.execPath, args: [modern] },
    { id: randomUUID(), name: 'stdio legacy', transport: 'stdio', command: process.execPath, args: [legacy] },
    { id: randomUUID(), name: 'http modern', transport: 'streamable-http', url: await listen('http-server.mjs', children) },
    { id: randomUUID(), name: 'http legacy', transport: 'streamable-http', url: await listen('http-server.mjs', children, { LEGACY: '1' }) },
    { id: randomUUID(), name: 'sse modern', transport: 'sse', url: await listen('sse-server.mjs', children) },
    { id: randomUUID(), name: 'sse legacy', transport: 'sse', url: await listen('sse-server.mjs', children, { LEGACY: '1' }) },
  ];
  const { dataDir, path, id } = seed(servers);
  const { app, page } = await launch(dataDir);
  let shown = 0;
  try {
    await openWorkspace(page);
    for (const s of servers) {
      const era = s.name.endsWith('legacy') ? 'legacy' : 'modern';
      assert.match(await connect(page, s.name), new RegExp(`Connected, ${era} era`), s.name);
      if (s.transport !== 'stdio') assert.equal(await page.locator('.auth').count(), 0, `${s.name}: no sign of OAuth, so no Sign-in panel`);
      shown += await page.locator('.log-line').count();
      await disconnect(page);
    }
  } finally {
    await app.close();
  }
  const ws = openWorkspaceDb({ path, workspaceId: id, custody: { kind: 'none' }, secrets: noSecrets });
  try {
    const stored = ws.db.prepare('SELECT count(*) AS n FROM wire_unit').get().n;
    assert.ok(shown > servers.length * 2, `only ${shown} rows shown`);
    // Every row the log showed while connected is stored; the exit event and
    // the goodbye traffic after each screenshot of the log account for the rest.
    assert.ok(stored >= shown, `${stored} units stored, ${shown} shown`);
  } finally {
    ws.close();
  }
});

test('the era is shown, pinned, survives a restart, and a second connect spawns the server once', async () => {
  const spawns = spawnLog();
  const s = { id: randomUUID(), name: 'pinned', transport: 'stdio', command: process.execPath, args: [modern], env: { SPAWN_LOG: spawns } };
  const { dataDir } = seed([s]);
  let first = await launch(dataDir);
  try {
    await openWorkspace(first.page);
    await connect(first.page, 'pinned');
    await disconnect(first.page);
  } finally {
    await first.app.close();
  }
  first = await launch(dataDir);
  try {
    await openWorkspace(first.page);
    assert.match(await first.page.locator('.server-row', { hasText: 'pinned' }).innerText(), /modern 2026-07-28/, 'the pinned era survives a restart');
    await connect(first.page, 'pinned');
    assert.equal(pids(spawns).length, 2, 'one spawn per connect, no probe sibling');
    await disconnect(first.page);
  } finally {
    await first.app.close();
  }
});

test('a command that does not exist is reported as never started, not as a protocol error', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'missing', transport: 'stdio', command: 'mcpx-no-such-command-anywhere' }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'missing', 'The command never started');
  } finally {
    await app.close();
  }
});

test('D36: quitting leaves no server process tree behind, even one that ignores stdin EOF and SIGTERM', async () => {
  const spawns = spawnLog();
  const { dataDir } = seed([{ id: randomUUID(), name: 'stubborn', transport: 'stdio', ...wrapped(modern, { STUBBORN: '1', SPAWN_LOG: spawns }) }]);
  const { app, page } = await launch(dataDir);
  let root;
  try {
    await openWorkspace(page);
    await connect(page, 'stubborn');
    root = Number(/Process (\d+)/.exec(await page.locator('.state-card').innerText())[1]);
  } finally {
    await app.close();
  }
  const [server] = pids(spawns);
  assert.ok(root !== server, 'the root is the shell, not the node server');
  assert.ok(await gone(root), `the shell ${root} outlived the app`);
  assert.ok(await gone(server), `the server ${server} under the shell outlived the app`);
});

test('D36: when the backend process dies, its server trees are killed and the window says so', async () => {
  const spawns = spawnLog();
  const { dataDir } = seed([{ id: randomUUID(), name: 'orphan', transport: 'stdio', ...wrapped(modern, { STUBBORN: '1', SPAWN_LOG: spawns }) }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'orphan');
    const backend = (await app.evaluate(({ app: a }) => a.getAppMetrics()))
      .find((m) => m.type === 'Utility' && m.name === 'MCP Explorer backend');
    assert.ok(backend, 'no backend utility process in the app metrics');
    process.kill(backend.pid, 'SIGKILL');
    await page.getByText('The backend stopped').waitFor({ timeout: 15_000 });
    const [server] = pids(spawns);
    assert.ok(await gone(server), `the server ${server} outlived its backend`);
  } finally {
    await app.close();
  }
});

test('D36: a hard kill of the whole app is best effort, and a server that exits on stdin EOF does', async () => {
  const spawns = spawnLog();
  const { dataDir } = seed([{ id: randomUUID(), name: 'polite', transport: 'stdio', command: process.execPath, args: [modern], env: { SPAWN_LOG: spawns } }]);
  const { app, page } = await launch(dataDir);
  await openWorkspace(page);
  await connect(page, 'polite');
  const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics());
  // Kill every Electron process at once, the way Task Manager ends the app:
  // nothing in the app gets to clean up.
  for (const m of metrics) { try { process.kill(m.pid, 'SIGKILL'); } catch { /* already gone with its parent */ } }
  const [server] = pids(spawns);
  assert.ok(await gone(server), `the server ${server} did not exit when its stdin closed`);
});

// --- phase 05 -----------------------------------------------------------------------------

test('settings persist per workspace and survive a restart', async () => {
  const { dataDir } = seed([]);
  let run = await launch(dataDir);
  try {
    await openWorkspace(run.page);
    await run.page.getByRole('button', { name: 'Settings', exact: true }).click();
    await run.page.getByLabel('Rounds before pausing a call').fill('7');
    await run.page.getByLabel('Ask before calls').uncheck();
    await run.page.getByRole('button', { name: 'Save', exact: true }).click();
    await run.page.getByText('Saved.').waitFor();
  } finally {
    await run.app.close();
  }
  run = await launch(dataDir);
  try {
    await openWorkspace(run.page);
    await run.page.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(await run.page.getByLabel('Rounds before pausing a call').inputValue(), '7');
    assert.equal(await run.page.getByLabel('Ask before calls').isChecked(), false);
  } finally {
    await run.app.close();
  }
});

test('import: the Cursor config in a project folder is found, reviewed with its command shown, and imported; the secret value is not kept', async () => {
  const folder = mkdtempSync(join(work, 'project-'));
  const secret = 'smoke-secret-value-4242';
  mkdirSync(join(folder, '.cursor'));
  writeFileSync(join(folder, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { imported: { command: process.execPath, args: [modern], env: { API_KEY: secret, MODE: 'x' } } } }));
  const { dataDir } = seed([]);
  const { app, page } = await launch(dataDir);
  try {
    // The system folder dialog cannot be driven; it answers with the folder.
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, folder);
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('button', { name: 'Add a project folder' }).click();
    await page.getByText('Cursor, project').waitFor();
    // Real user-level files on this machine may be found too; they are unticked and never read.
    for (const box of await page.locator('.import .choice', { hasNotText: 'Cursor, project' }).locator('input').all()) await box.uncheck();
    await page.getByRole('button', { name: 'Read 1 file' }).click();
    await page.locator('.will-run code', { hasText: 'modern-server.mjs' }).waitFor();
    assert.equal(await page.getByLabel('API_KEY is a secret').isChecked(), true, 'a credential-looking name is pre-marked');
    await page.getByText('this workspace is not encrypted', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Import 1 server' }).click();
    await page.getByText('Imported 1 server').waitFor();
    await page.getByRole('button', { name: 'Done' }).click();
    await page.locator('.server-row', { hasText: 'imported' }).waitFor();
  } finally {
    await app.close();
  }
  for (const f of readdirSync(dataDir, { recursive: true }).map((r) => join(dataDir, r)).filter((p) => statSync(p).isFile())) {
    assert.ok(!readFileSync(f).includes(secret), `the secret's value was written to ${f}`);
  }
});

test('after a backend restart the popped-out readable window has a live port again', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'readable', transport: 'stdio', command: process.execPath, args: [modern] }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'readable');
    await disconnect(page);
    const popped = app.waitForEvent('window');
    await page.getByRole('button', { name: 'Pop out' }).click();
    const readable = await popped;
    await readable.locator('.readable-window').waitFor();
    const backend = (await app.evaluate(({ app: a }) => a.getAppMetrics())).find((m) => m.type === 'Utility' && m.name === 'MCP Explorer backend');
    process.kill(backend.pid, 'SIGKILL');
    await page.getByText('The backend stopped').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Restart' }).click();
    await openWorkspace(page);
    await page.locator('.server-row', { hasText: 'readable' }).click();
    await page.locator('.log-line').first().click();
    // The unit is read through the readable window's own port: a dead one never answers.
    await readable.locator('.readable-body').waitFor({ timeout: 10_000 });
  } finally {
    await app.close();
  }
});

test('R05-7: a restart request while the backend is running does not reset the page', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'kept', transport: 'stdio', command: process.execPath, args: [modern] }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await page.locator('.server-row', { hasText: 'kept' }).click();
    await page.getByRole('button', { name: 'Connect', exact: true }).waitFor();
    // A second Restart click, or one from another window, arrives with the backend alive.
    await page.evaluate(() => window.mcpxShell.restartBackend());
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(await page.getByRole('button', { name: 'Connect', exact: true }).isVisible(), 'the page was remounted and lost the selected server');
  } finally {
    await app.close();
  }
});

// --- Phase 06: surface views and the context preview ---------------------------------------

/** Connects and waits for the capture that connecting starts, shown as the tools tab's count. */
async function connectAndCapture(page, name, tools) {
  await connect(page, name);
  await page.getByRole('tab', { name: `Tools ${tools}` }).waitFor({ timeout: 20_000 });
}

test('surface: connecting captures it; a tool opens on its exact bytes and the pane reads it (board 5.1A)', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'surface', transport: 'stdio', command: process.execPath, args: [modern] }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connectAndCapture(page, 'surface', 2);
    assert.ok(await page.getByRole('tab', { name: 'Prompts 1' }).isVisible());
    await page.locator('.surface-items .item', { hasText: 'echo' }).click();
    await page.locator('.entry-source', { hasText: 'Exact bytes from wire log unit' }).waitFor();
    assert.ok(await page.locator('.surface-entry .raw-viewer').isVisible());
    const pane = page.locator('.readable-pane');
    await pane.getByText('Hints the server declares about itself').waitFor();
    assert.ok(await pane.locator('.params .param-desc', { hasText: 'What to echo.' }).first().isVisible(), 'the parameter description');
    await page.getByRole('tab', { name: 'Instructions' }).click();
    assert.equal(await page.locator('pre.instructions').innerText(), 'Phase 01 fixture. Modern era.');
    assert.ok(await page.getByText('only on a listen stream: open one under Session').isVisible(), 'modern change notices are said to need a listen stream (phase 10)');
  } finally {
    await app.close();
  }
});

test('surface: a legacy change notice shows a banner, nothing is re-listed until Refresh (P2)', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'changing', transport: 'stdio', command: process.execPath, args: [legacy], env: { LIST_CHANGED: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connectAndCapture(page, 'changing', 1);
    const banner = page.locator('.banner', { hasText: 'The server says its tools changed' });
    await banner.waitFor({ timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(await page.getByRole('tab', { name: 'Tools 1' }).isVisible(), 'still the first capture');
    await banner.getByRole('button', { name: 'Refresh' }).click();
    await page.getByRole('tab', { name: 'Tools 2' }).waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('.banner').count(), 0);
  } finally {
    await app.close();
  }
});

test('context: two servers sharing a tool name show the collision, and leaving one out removes it', async () => {
  const { dataDir } = seed([
    { id: randomUUID(), name: 'one modern', transport: 'stdio', command: process.execPath, args: [modern] },
    { id: randomUUID(), name: 'two legacy', transport: 'stdio', command: process.execPath, args: [legacy] },
  ]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connectAndCapture(page, 'one modern', 2);
    await disconnect(page);
    await connectAndCapture(page, 'two legacy', 1);
    await disconnect(page);
    await page.getByRole('button', { name: 'Context', exact: true }).click();
    const collisions = page.locator('.collisions');
    await collisions.waitFor();
    assert.match(await collisions.innerText(), /echo from one modern, two legacy/);
    assert.match(await page.locator('.context-total').innerText(), /^\d+ tokens/);
    assert.match(await page.locator('.tokenizer-label').innerText(), /o200k_base tokens/);
    await page.getByRole('checkbox', { name: 'Include two legacy' }).uncheck();
    await page.getByText('None. Every tool name in the block is unique.').waitFor();
  } finally {
    await app.close();
  }
});

// --- phase 07: calling tools ----------------------------------------------------------

/** Where to write screenshots of the call views, for a person to look at; none unless MCPX_SHOTS is set. */
const shot = async (page, name) => {
  if (process.env.MCPX_SHOTS) await page.screenshot({ path: join(process.env.MCPX_SHOTS, `${name}.png`) });
};

async function openCall(page, tool) {
  await page.locator('.surface-items button', { hasText: new RegExp(`^${tool}`) }).first().click();
  await page.getByRole('tab', { name: 'Call', exact: true }).click();
}

/** One of the server view's tabs (Surface, Calls, Notifications, Versions); the others stay mounted and hidden. */
const serverTab = (page, name) => page.locator('.server-tabs').getByRole('tab', { name, exact: true }).click();

const callButton = (page) => page.locator('.call-panel > .actions').getByRole('button', { name: 'Call', exact: true });
const transcriptStatus = (page, text) => page.locator('.call-panel .transcript .call-status', { hasText: text });

test('calls: a read-only tool runs from the form without a confirm, and its result is read in the pane', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'calls', transport: 'stdio', command: process.execPath, args: [modern], env: { CALL_TOOLS: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'calls');
    await openCall(page, 'add');
    // By name: the modern fixture shuffles schema keys, and the form keeps the server's order (R07-7).
    const input = (name) => page.locator('.call-form label.field', { has: page.locator('span.mono', { hasText: new RegExp(`^${name}$`) }) }).locator('input');
    await input('a').fill('20');
    await input('b').fill('22');
    await page.locator('.call-editor textarea').filter({ hasText: '"b": 22' }).waitFor();
    await page.locator('.ok-line', { hasText: 'match the schema' }).waitFor();
    await shot(page, '07-1-form');
    await callButton(page).click();
    await transcriptStatus(page, 'Completed').waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('.modal').count(), 0, 'add is declared read-only: no confirm');
    await page.locator('.readable-pane .part-text', { hasText: '42' }).waitFor();
    await page.locator('.readable-pane .ok-line', { hasText: 'Matches the outputSchema' }).waitFor();
    await shot(page, '07-2-result');
    await serverTab(page, 'Calls');
    await page.locator('.call-history td', { hasText: 'add' }).first().waitFor();
  } finally {
    await app.close();
  }
});

test('calls: a tool not declared read-only asks first; "Do not send" sends nothing', async () => {
  const { dataDir, path, id } = seed([{ id: randomUUID(), name: 'calls', transport: 'stdio', command: process.execPath, args: [modern], env: { CALL_TOOLS: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'calls');
    await openCall(page, 'hint_destructive');
    await callButton(page).click();
    const modal = page.locator('.modal');
    await modal.waitFor();
    assert.match(await modal.innerText(), /destructiveHint: true/);
    assert.match(await modal.innerText(), /"name": "hint_destructive"/);
    await shot(page, '07-3-confirm');
    await modal.getByRole('button', { name: 'Do not send' }).click();
    assert.equal(await page.locator('.call-panel .transcript').count(), 0);
    await callButton(page).click();
    await page.locator('.modal').getByRole('button', { name: 'Send', exact: true }).click();
    await transcriptStatus(page, 'Completed').waitFor({ timeout: 10_000 });
  } finally {
    await app.close();
  }
  const ws = openWorkspaceDb({ path, workspaceId: id, custody: { kind: 'none' }, secrets: noSecrets });
  try {
    assert.equal(ws.db.prepare("SELECT count(*) AS n FROM frame WHERE method = 'tools/call' AND direction = 'out'").get().n, 1, 'only the confirmed call went out');
  } finally {
    ws.close();
  }
});

test('calls: progress shows while a call runs, and Cancel ends it cancelled', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'calls', transport: 'stdio', command: process.execPath, args: [legacy], env: { CALL_TOOLS: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'calls');
    await openCall(page, 'slow');
    await page.locator('.call-editor textarea').fill('{"steps": 200, "delayMs": 50}');
    await callButton(page).click();
    await page.locator('.call-panel .progress', { hasText: /Progress \d+ of 200/ }).waitFor({ timeout: 10_000 });
    await shot(page, '07-4-progress');
    await page.locator('.call-panel .transcript').getByRole('button', { name: 'Cancel' }).click();
    await transcriptStatus(page, 'Cancelled').waitFor({ timeout: 10_000 });
  } finally {
    await app.close();
  }
});

test('calls: every content type renders, and one no revision defines is labelled, not dropped', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'calls', transport: 'stdio', command: process.execPath, args: [modern], env: { CALL_TOOLS: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'calls');
    await openCall(page, 'media');
    await callButton(page).click();
    await transcriptStatus(page, 'Completed').waitFor({ timeout: 10_000 });
    const pane = page.locator('.readable-pane');
    await pane.locator('img').waitFor();
    await pane.locator('audio').waitFor();
    await pane.getByText('which no MCP revision defines').waitFor();
    await pane.getByText('The MCP client library refused this result', { exact: false }).first().waitFor();
    await shot(page, '07-5-media');
  } finally {
    await app.close();
  }
});

test('calls: a prompt is got from its argument form, and a template resource is read from its variables', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'calls', transport: 'stdio', command: process.execPath, args: [legacy], env: { CALL_TOOLS: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'calls');
    await page.getByRole('tab', { name: /^Prompts/ }).click();
    await page.locator('.surface-items button', { hasText: 'review' }).click();
    await page.getByRole('tab', { name: 'Get', exact: true }).click();
    await page.locator('.call-form label', { hasText: 'language' }).locator('input').fill('rust');
    await page.locator('.call-panel > .actions').getByRole('button', { name: 'Get', exact: true }).click();
    await page.locator('.readable-pane .part-text', { hasText: 'Review this rust code' }).waitFor({ timeout: 10_000 });
    await page.getByRole('tab', { name: /^Templates/ }).click();
    await page.locator('.surface-items button', { hasText: 'fixture://notes/{day}' }).click();
    await page.getByRole('tab', { name: 'Read', exact: true }).click();
    await page.locator('.call-form label', { hasText: 'day' }).locator('input').fill('monday');
    await page.locator('.call-panel > .actions').getByRole('button', { name: 'Read', exact: true }).click();
    await page.locator('.readable-pane .part-text', { hasText: 'Notes for monday.' }).waitFor({ timeout: 10_000 });
    await shot(page, '07-6-template');
  } finally {
    await app.close();
  }
});

test('calls: a 9.5 MB result is shown whole, raw in the transcript and readable in the pane (time printed)', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'calls', transport: 'stdio', command: process.execPath, args: [modern], env: { CALL_TOOLS: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'calls');
    await openCall(page, 'big');
    await page.locator('.call-form input').first().fill(String(Math.floor(9.5 * 1024 * 1024)));
    const started = Date.now();
    await callButton(page).click();
    await transcriptStatus(page, 'Completed').waitFor({ timeout: 60_000 });
    await page.locator('.readable-pane .part-text').waitFor({ timeout: 60_000 });
    const shownMs = Date.now() - started;
    await page.locator('.call-panel .transcript .entry-source', { hasText: /^Response/ }).waitFor({ timeout: 60_000 });
    const rawMs = Date.now() - started;
    process.stdout.write(`# 9.5 MB result: readable pane ${shownMs} ms, raw response ${rawMs} ms after Call\n`);
    await shot(page, '07-7-big');
    // The wire log row for it arrived without its bytes, and selecting it loads them.
    const row = page.locator('.log-line', { hasText: 'tools/call' }).last();
    await row.click();
    await page.locator('.log-row.selected .raw-viewer').waitFor({ timeout: 60_000 });
  } finally {
    await app.close();
  }
});

/** Counts the requests the page sends the backend, by method, from now on. */
async function countRequests(page) {
  await page.evaluate(() => {
    const w = window;
    w.__requests = [];
    if (w.__hooked) return;
    w.__hooked = true;
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (m, ...rest) {
      if (m && m.kind === 'request') w.__requests.push(m.method);
      return post.call(this, m, ...rest);
    };
  });
  return async (method) => page.evaluate((m) => window.__requests.filter((x) => x === m).length, method);
}

test('R07-1: a prompt\'s argument form validates once after typing stops, not forever', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'calls', transport: 'stdio', command: process.execPath, args: [legacy], env: { CALL_TOOLS: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'calls');
    await page.getByRole('tab', { name: /^Prompts/ }).click();
    await page.locator('.surface-items button', { hasText: 'review' }).click();
    await page.getByRole('tab', { name: 'Get', exact: true }).click();
    await page.locator('.call-form label', { hasText: 'language' }).locator('input').fill('rust');
    await page.waitForTimeout(1000);
    const count = await countRequests(page);
    await page.waitForTimeout(2000);
    assert.equal(await count('calls.validate'), 0, 'nothing changed, so nothing is validated again');
  } finally {
    await app.close();
  }
});

test('R07-5: progress updates the transcript without re-listing the call history', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'calls', transport: 'stdio', command: process.execPath, args: [legacy], env: { CALL_TOOLS: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'calls');
    await openCall(page, 'slow');
    await page.locator('.call-editor textarea').fill('{"steps": 40, "delayMs": 25}');
    const count = await countRequests(page);
    await callButton(page).click();
    await transcriptStatus(page, 'Completed').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    const lists = await count('calls.list');
    assert.ok(lists <= 3, `the call list was fetched ${lists} times for one call with 40 progress notifications`);
    assert.ok(await count('calls.get') >= 10, 'the transcript still follows progress');
  } finally {
    await app.close();
  }
});

test('R07-6: a large result in the pane is not re-serialized when something else re-renders the app', async () => {
  const { dataDir } = seed([
    { id: randomUUID(), name: 'calls', transport: 'stdio', command: process.execPath, args: [modern], env: { CALL_TOOLS: '1' } },
    { id: randomUUID(), name: 'other', transport: 'stdio', command: process.execPath, args: [modern], env: { EXIT_AFTER_MS: '6000' } },
  ]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'other');
    await connect(page, 'calls');
    await openCall(page, 'big');
    await page.locator('.call-form input').first().fill(String(2 * 1024 * 1024));
    await callButton(page).click();
    await page.locator('.readable-pane .part-text').waitFor({ timeout: 30_000 });
    await page.evaluate(() => {
      const w = window;
      w.__bigStringify = 0;
      const stringify = JSON.stringify;
      JSON.stringify = function (...a) {
        const out = stringify.apply(this, a);
        if (typeof out === 'string' && out.length > 1_000_000) w.__bigStringify++;
        return out;
      };
    });
    // The other server exits on its own; its state change re-renders the app.
    await page.locator('.server-row', { hasText: 'other' }).getByText('Connected').waitFor({ state: 'detached', timeout: 20_000 });
    assert.ok(await page.locator('.readable-pane .part-text').isVisible(), 'the result is still in the pane');
    assert.equal(await page.evaluate(() => window.__bigStringify), 0);
  } finally {
    await app.close();
  }
});

// --- phase 08: client-side callbacks -----------------------------------------------------

/** Calls the open tool, confirming it: none of the phase 08 tools declares itself read-only. */
async function callConfirmed(page) {
  await callButton(page).click();
  await page.locator('.modal').getByRole('button', { name: 'Send', exact: true }).click();
}

const sendRetry = (page) => page.getByRole('button', { name: 'Send answers and retry' });
const outCalls = (path, id) => {
  const ws = openWorkspaceDb({ path, workspaceId: id, custody: { kind: 'none' }, secrets: noSecrets });
  try {
    return ws.db.prepare("SELECT count(*) AS n FROM frame WHERE method = 'tools/call' AND direction = 'out'").get().n;
  } finally {
    ws.close();
  }
};

test('MRTR: sampling and elicitation in one result are two cards, sent together only when both are answered (board 6.3)', async () => {
  const { dataDir, path, id } = seed([{ id: randomUUID(), name: 'asks', transport: 'stdio', command: process.execPath, args: [modern], env: { CALL_TOOLS: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'asks');
    await openCall(page, 'mrtr_both');
    await callConfirmed(page);
    await transcriptStatus(page, 'Waiting for input').waitFor({ timeout: 10_000 });
    const cards = page.locator('.input-set .input-card');
    await cards.nth(1).waitFor();
    assert.equal(await cards.count(), 2);
    assert.ok(await page.getByText('Sampling is deprecated in 2026-07-28').isVisible(), 'sampling marked deprecated on this revision');
    assert.equal(await sendRetry(page).isDisabled(), true, 'nothing answered yet');
    await page.getByRole('textbox', { name: 'Sampling reply' }).fill('Ports carry the tide.');
    assert.equal(await sendRetry(page).isDisabled(), true, 'one of two answered');
    const elicit = page.locator('.input-card', { hasText: 'Publish it?' });
    await elicit.getByRole('radio', { name: 'Accept with these values' }).check();
    await elicit.locator('.call-form select').first().selectOption('true');
    await elicit.locator('.call-editor textarea').filter({ hasText: '"publish": true' }).waitFor();
    await shot(page, '08-1-answer-set');
    await sendRetry(page).click();
    await transcriptStatus(page, 'Completed').waitFor({ timeout: 10_000 });
    await page.locator('.readable-pane .part-text', { hasText: 'requestState intact' }).waitFor();
    assert.match(await page.locator('.readable-pane').innerText(), /Ports carry the tide/);
    assert.equal(await page.locator('.call-panel .transcript .round h4', { hasText: /^Round/ }).count(), 2, 'two rounds');
  } finally {
    await app.close();
  }
  assert.equal(outCalls(path, id), 2, 'the call and its one retry');
});

test('MRTR, D21: the soft cap pauses the call naming the server and the count; Stop ends it capped (board 6.4)', async () => {
  const { dataDir, path, id } = seed([{ id: randomUUID(), name: 'loops', transport: 'stdio', command: process.execPath, args: [modern], env: { CALL_TOOLS: '1' } }]);
  const ws = openWorkspaceDb({ path, workspaceId: id, custody: { kind: 'none' }, secrets: noSecrets });
  ws.db.prepare('UPDATE workspace_meta SET mrtr_soft_cap = 2').run();
  ws.close();
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'loops');
    await openCall(page, 'mrtr_loop');
    await callConfirmed(page);
    await page.locator('.input-card', { hasText: 'Round 1: go again?' }).getByRole('radio', { name: 'Decline' }).check({ timeout: 10_000 });
    await sendRetry(page).click();
    const pause = page.locator('.pause-box');
    await pause.waitFor({ timeout: 10_000 });
    assert.match(await pause.innerText(), /loops has asked for input 2 times on mrtr_loop/);
    await transcriptStatus(page, 'Paused at the round limit').waitFor();
    assert.equal(await page.locator('.input-set').count(), 0, 'no answers while paused');
    await shot(page, '08-2-soft-cap');
    await pause.getByRole('button', { name: 'Keep answering' }).click();
    await page.locator('.input-card', { hasText: 'Round 2: go again?' }).getByRole('radio', { name: 'Decline' }).check({ timeout: 10_000 });
    await sendRetry(page).click();
    await page.locator('.input-card', { hasText: 'Round 3: go again?' }).getByRole('radio', { name: 'Decline' }).check({ timeout: 10_000 });
    await sendRetry(page).click();
    await page.locator('.pause-box', { hasText: '4 times' }).waitFor({ timeout: 10_000 });
    await page.locator('.pause-box').getByRole('button', { name: 'Stop the call' }).click();
    await transcriptStatus(page, 'Stopped at the round limit').waitFor({ timeout: 10_000 });
  } finally {
    await app.close();
  }
  assert.equal(outCalls(path, id), 4);
});

test('MRTR: a URL-mode request shows the whole URL and its host, and opens only on the click (decision 9)', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'url', transport: 'stdio', command: process.execPath, args: [modern], env: { CALL_TOOLS: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    // Stand in for the system browser: record what would open.
    await app.evaluate(({ shell }) => {
      globalThis.opened = [];
      shell.openExternal = async (url) => { globalThis.opened.push(url); };
    });
    await openWorkspace(page);
    await connect(page, 'url');
    await openCall(page, 'mrtr_url');
    await callConfirmed(page);
    const box = page.locator('.url-box');
    await box.waitFor({ timeout: 10_000 });
    assert.equal(await box.locator('strong').innerText(), 'auth.example.com');
    assert.equal(await box.locator('.url-full').innerText(), 'https://auth.example.com/authorize?client=fixture&state=abc123');
    await shot(page, '08-3-url');
    assert.deepEqual(await app.evaluate(() => globalThis.opened), [], 'nothing opened before the click');
    await box.getByRole('button', { name: 'Open in browser' }).click();
    await box.getByText('Opened in your browser.').waitFor();
    assert.deepEqual(await app.evaluate(() => globalThis.opened), ['https://auth.example.com/authorize?client=fixture&state=abc123']);
    // The main process refuses anything but http and https, whatever the page asks.
    assert.deepEqual(await page.evaluate(async () => [await window.mcpxShell.openExternal('javascript:alert(1)'), await window.mcpxShell.openExternal('file:///etc/passwd')]), [false, false]);
    assert.equal((await app.evaluate(() => globalThis.opened)).length, 1);
    await page.locator('.input-card').getByRole('radio', { name: 'Accept (I will visit it)' }).check();
    await sendRetry(page).click();
    await transcriptStatus(page, 'Completed').waitFor({ timeout: 10_000 });
  } finally {
    await app.close();
  }
});

test('legacy: a sampling request mid-call waits under "Requests from the server", and the reply completes the call', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'legacy asks', transport: 'stdio', command: process.execPath, args: [legacy], env: { CALL_TOOLS: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'legacy asks');
    await openCall(page, 'ask_sampling');
    await callConfirmed(page);
    const panel = page.locator('.server-requests');
    await panel.getByText('The server is waiting for your answer.').waitFor({ timeout: 10_000 });
    await page.locator('.call-panel .transcript', { hasText: 'Requests from the server during this call' }).waitFor();
    assert.equal(await page.getByText('Sampling is deprecated').count(), 0, 'not deprecated on a legacy revision');
    await panel.getByRole('textbox', { name: 'Sampling reply' }).fill('A reply from a person.');
    await shot(page, '08-4-legacy-request');
    await panel.getByRole('button', { name: 'Send reply' }).click();
    await transcriptStatus(page, 'Completed').waitFor({ timeout: 10_000 });
    await page.locator('.readable-pane .part-text', { hasText: 'A reply from a person.' }).waitFor();
    await panel.locator('summary', { hasText: 'Earlier requests (1)' }).click();
    await panel.locator('.earlier-request .call-status', { hasText: 'Answered' }).waitFor();
  } finally {
    await app.close();
  }
});

test('legacy: a refusal sends the chosen error, and the server sees it', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'refuse', transport: 'stdio', command: process.execPath, args: [legacy], env: { CALL_TOOLS: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'refuse');
    await openCall(page, 'ask_elicit');
    await callConfirmed(page);
    const panel = page.locator('.server-requests');
    await panel.getByRole('button', { name: 'Refuse' }).click({ timeout: 10_000 });
    await panel.getByRole('button', { name: 'Send refusal' }).click();
    await transcriptStatus(page, 'Completed').waitFor({ timeout: 10_000 });
    await page.locator('.readable-pane .part-text', { hasText: 'User rejected the request' }).waitFor();
  } finally {
    await app.close();
  }
});

test('R07-7: a tool form lists its fields in the server order, not alphabetically', async () => {
  // The legacy fixture keeps its key order; the modern one shuffles keys on every reply, on purpose.
  const { dataDir } = seed([{ id: randomUUID(), name: 'order', transport: 'stdio', command: process.execPath, args: [legacy], env: { CALL_TOOLS: '1' } }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'order');
    await openCall(page, 'schema_primitives');
    // The labels settle once the entry's bytes arrive.
    await page.waitForFunction(() => [...document.querySelectorAll('.call-form label.field > span > span.mono')].map((e) => e.textContent).join(',') === 'text,count,ratio,flag,colour,when', undefined, { timeout: 10_000 });
  } finally {
    await app.close();
  }
});

test('R08-4: a tool form open across a Refresh follows the new schema', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'changing form', transport: 'stdio', command: process.execPath, args: [legacy], env: { LIST_CHANGED: '1' } }]);
  const { app, page } = await launch(dataDir);
  const labels = () => page.evaluate(() => [...document.querySelectorAll('.call-form label.field > span > span.mono')].map((e) => e.textContent).join(','));
  try {
    await openWorkspace(page);
    await connectAndCapture(page, 'changing form', 1);
    await openCall(page, 'echo');
    await page.waitForFunction(() => document.querySelectorAll('.call-form label.field').length === 1);
    assert.equal(await labels(), 'text');
    await page.locator('.banner', { hasText: 'The server says its tools changed' }).getByRole('button', { name: 'Refresh' }).click({ timeout: 10_000 });
    await page.getByRole('tab', { name: 'Tools 2' }).waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => document.querySelectorAll('.call-form label.field').length === 2, undefined, { timeout: 10_000 });
    assert.equal(await labels(), 'text,loud');
  } finally {
    await app.close();
  }
});

/** One capture of a fixture under these knobs, outside the app: an earlier session's. */
async function fixtureSurface(script, env) {
  const conn = await connectStdio({ command: process.execPath, args: [script], env: { ...process.env, ...env } });
  try { return await captureSurface(conn.source); } finally { await conn.close(); }
}

test('versions: a changed description is a new version whose diff opens on what the model sees; a version bump is identity only (board 7)', async () => {
  const id = randomUUID();
  const env = { MUTATE_AFTER: '1', SERVER_VERSION: '1.0.1' };
  const day = 86_400_000;
  const { dataDir } = seed([{ id, name: 'versioned', transport: 'stdio', command: process.execPath, args: [modern], env }], [
    [id, await fixtureSurface(modern, { SERVER_VERSION: '1.0.0' }), Date.now() - 2 * day],
    [id, await fixtureSurface(modern, { SERVER_VERSION: '1.0.1' }), Date.now() - day],
  ]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connectAndCapture(page, 'versioned', 2);
    await serverTab(page, 'Versions');
    const rows = page.locator('.versions-table tr');
    await rows.nth(1).waitFor();
    assert.equal(await rows.count(), 2, 'the connect captured the identity entry again: still two rows');
    await serverTab(page, 'Surface');
    await page.getByRole('button', { name: 'Refresh' }).click();
    await serverTab(page, 'Versions');
    await rows.nth(2).waitFor({ timeout: 20_000 });
    assert.deepEqual(await rows.locator('.version-title').allInnerTexts(), ['Version 2', 'Identity only', 'Version 1'], 'newest first');
    assert.equal(await rows.nth(1).getAttribute('data-kind'), 'identity');
    assert.match(await rows.nth(1).innerText(), /Version changed, surface identical: version 1\.0\.0 to 1\.0\.1/);
    assert.match(await rows.nth(1).innerText(), /2 captures/);

    await rows.nth(0).click();
    const diff = page.locator('.version-diff');
    await diff.locator('.diff-line.removed').waitFor();
    assert.equal(await diff.getByRole('tab', { name: 'What the model sees' }).getAttribute('aria-selected'), 'true', 'the diff opens on what the model sees (7.1B)');
    assert.match(await diff.locator('.diff-line.added').innerText(), /Echoes its input\. \(revised\)/);
    assert.equal(await diff.locator('.diff-line.added mark').innerText(), ' (revised)');
    assert.match(await diff.locator('.token-line').innerText(), /^\+\d+ tokens \(\d+ to \d+, o200k_base\)$/);
    assert.equal(await page.locator('.compare-with select').inputValue(), '1', 'compared with the entry before it');

    await diff.getByRole('tab', { name: 'By item' }).click();
    const item = diff.locator('.field-table tbody tr');
    assert.equal(await item.count(), 1, 'exactly one change');
    assert.deepEqual((await item.locator('td').allInnerTexts()).slice(1, 3), ['echo', '/description']);
    await diff.getByRole('tab', { name: 'Raw snapshots' }).click();
    await diff.getByText('Not wire bytes').waitFor();
    assert.ok(await diff.locator('.diff-line.added', { hasText: '(revised)' }).isVisible());

    await rows.nth(1).click();
    await page.locator('.version-diff .token-line', { hasText: 'No token change' }).waitFor();
    assert.ok(await page.getByText('Nothing the model sees changed.').isVisible());
    await page.locator('.compare-with select').selectOption('2');
    await page.locator('.version-diff .diff-line.added', { hasText: '(revised)' }).waitFor();
  } finally {
    await app.close();
  }
});

test('versions: every recent capture a different version is flagged unstable (decision 7)', async () => {
  const id = randomUUID();
  const hour = 3_600_000;
  const now = Date.now();
  const captures = [];
  for (const [i, v] of ['1', '2', '3', '4'].entries()) captures.push([id, await fixtureSurface(modern, { SERVER_VERSION: v }), now - (4 - i) * hour]);
  const { dataDir } = seed([{ id, name: 'flaky', transport: 'stdio', command: process.execPath, args: [modern] }], captures);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await page.locator('.server-row', { hasText: 'flaky' }).click();
    await serverTab(page, 'Versions');
    await page.locator('.versions .warn').waitFor();
    assert.equal(await page.locator('.versions .warn').innerText(), 'Unstable: the last 4 captures each produced a different version, over 3 hours.');
    assert.equal(await page.locator('.versions-table tr.identity').count(), 3, 'identity rows stay compact');
  } finally {
    await app.close();
  }
});

// Phase 10: protocol completeness.

const extrasServer = (name, script, env = {}) => ({ id: randomUUID(), name, transport: 'stdio', command: process.execPath, args: [script], env: { EXTRAS: '1', ...env } });
const surfaceReady = (page) => page.locator('.surface .tabs').waitFor({ timeout: 20_000 });

test('health check: one press connects, lists, and flags every malformed element (decision 12)', async () => {
  const { dataDir } = seed([extrasServer('health', legacy, { MALFORMED_SURFACE: '1', LEGACY_REVISION: '2025-11-25' })]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await page.locator('.server-row', { hasText: 'health' }).click();
    await page.getByRole('button', { name: 'Health check', exact: true }).click();
    const report = page.locator('.health');
    await report.locator('h3', { hasText: /problems? found/ }).waitFor({ timeout: 20_000 });
    for (const text of ['Revision 2025-11-25 (legacy era)', 'tools/list no_schema', 'prompts/list bad_args', 'resources/list fixture://nameless', 'bad_schema inputSchema', 'Answered in']) {
      await report.getByText(text, { exact: false }).first().waitFor();
    }
    await page.locator('.state-card h3', { hasText: /Connected, legacy era/ }).waitFor();
    await shot(page, '10-1-health');
  } finally {
    await app.close();
  }
});

test('logging: a level set on a legacy session, and its messages in the notifications timeline (decisions 5, 6)', async () => {
  const { dataDir } = seed([extrasServer('logging', legacy)]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'logging');
    await surfaceReady(page);
    await page.locator('.session select').selectOption('critical');
    // The select is the session's level as the backend holds it: it shows the choice once logging/setLevel is answered.
    await page.waitForFunction(() => document.querySelector('.session select')?.value === 'critical', undefined, { timeout: 10_000 });
    await openCall(page, 'log_burst');
    await callButton(page).click();
    await transcriptStatus(page, 'Completed').waitFor({ timeout: 10_000 });
    const panel = page.locator('.notifications');
    await serverTab(page, 'Notifications');
    // Raw first (D10, R10-4): the unit as it arrived, then the Readable view.
    await panel.locator('.raw-params', { hasText: '"level":"critical"' }).waitFor({ timeout: 10_000 });
    await panel.getByLabel('Readable').check();
    await panel.getByText('critical from fixture: a critical message').waitFor({ timeout: 10_000 });
    await panel.getByText('emergency from fixture: a emergency message').waitFor();
    assert.equal(await panel.getByText('error from fixture').count(), 0, 'below the level, nothing');
  } finally {
    await app.close();
  }
});

test('modern: a listen carries the change notice, and the banner\'s Refresh lists the new tool (decisions 1, 7)', async () => {
  const { dataDir } = seed([extrasServer('listening', modern)]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'listening');
    await surfaceReady(page);
    await page.locator('.listen').getByRole('button', { name: 'Open listen' }).click();
    await page.locator('.listen', { hasText: 'Open. The server agreed to send: tool list changes' }).waitFor({ timeout: 10_000 });
    await openCall(page, 'mutate');
    await callConfirmed(page);
    await transcriptStatus(page, 'Completed').waitFor({ timeout: 10_000 });
    const banner = page.locator('.banner', { hasText: 'The server says its tools changed' });
    await banner.waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('.surface-items button', { hasText: /^mutated/ }).count(), 0, 'nothing re-listed on the notice');
    await banner.getByRole('button', { name: 'Refresh' }).click();
    await page.locator('.surface-items button', { hasText: /^mutated/ }).waitFor({ timeout: 10_000 });
    await shot(page, '10-2-listen-refresh');
  } finally {
    await app.close();
  }
});

test('legacy tasks: run as a task, nothing polls, Get result completes the call (decision 2)', async () => {
  const { dataDir } = seed([extrasServer('tasks', legacy, { LEGACY_REVISION: '2025-11-25' })]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'tasks');
    await surfaceReady(page);
    await openCall(page, 'task_work');
    await page.getByLabel(/Run as a task/).check();
    await callConfirmed(page);
    await page.locator('.call-panel .transcript .progress', { hasText: /Task task-\d+: working/ }).waitFor({ timeout: 10_000 });
    await page.locator('.call-panel .transcript').getByRole('button', { name: 'Get result' }).click();
    await transcriptStatus(page, 'Completed').waitFor({ timeout: 10_000 });
    await page.locator('.call-panel .transcript h4', { hasText: 'Round 2 (tasks/result)' }).waitFor();
    await page.locator('.readable-pane .part-text', { hasText: /done after 300 ms/ }).waitFor();
  } finally {
    await app.close();
  }
});

test('completions: Suggest sends one completion/complete and a suggestion fills the argument (decision 3)', async () => {
  const { dataDir, path, id } = seed([extrasServer('complete', legacy)]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'complete');
    await surfaceReady(page);
    await page.getByRole('tab', { name: /^Prompts/ }).click();
    await page.locator('.surface-items button', { hasText: /^pick/ }).click();
    await page.getByRole('tab', { name: 'Get', exact: true }).click();
    await page.locator('.call-form label.field', { has: page.locator('span.mono', { hasText: /^language$/ }) }).locator('input').fill('ty');
    await page.locator('.suggest').getByRole('button', { name: 'Suggest' }).click();
    await page.locator('.suggest').getByRole('button', { name: 'typescript' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.call-form input')].some((i) => i.value === 'typescript'));
    const ws = openWorkspaceDb({ path, workspaceId: id, custody: { kind: 'none' }, secrets: noSecrets });
    try {
      assert.equal(ws.db.prepare("SELECT count(*) AS n FROM frame WHERE method = 'completion/complete' AND direction = 'out'").get().n, 1, 'one request per press');
    } finally {
      ws.close();
    }
  } finally {
    await app.close();
  }
});

// Phase 11: OAuth through the real app. The test stands in for the browser:
// it reads the authorization URL the panel shows and follows the redirect to
// the loopback listener, so no real browser opens.
async function browseTo(authorizationUrl) {
  const r = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(r.status, 302);
  await (await fetch(r.headers.get('location'))).text();
}

async function signInFromCard(page) {
  await page.locator('.state-card h3', { hasText: 'The server needs you to sign in' }).waitFor({ timeout: 20_000 });
  await page.locator('.state-card').getByRole('button', { name: 'Sign in', exact: true }).click();
  const shown = page.locator('.auth .selectable');
  await shown.waitFor({ timeout: 20_000 });
  await page.locator('.auth').getByRole('button', { name: 'Open in browser' }).waitFor();
  await browseTo(await shown.innerText());
  await page.locator('.auth p', { hasText: /^Signed in with / }).waitFor({ timeout: 20_000 });
  await page.locator('.state-card h3', { hasText: 'Signed in since this failed: connect again' }).waitFor();
}

test('OAuth: a 401 offers Sign in; the page shows the URL, the browser comes back, and Connect succeeds; the log is redacted', async () => {
  const url = await listen('http-server.mjs', children, { AUTH: '1' });
  const { dataDir } = seed([{ id: randomUUID(), name: 'oauth', transport: 'streamable-http', url }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await page.locator('.server-row', { hasText: 'oauth' }).click();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await signInFromCard(page);
    await shot(page, '11-1-signed-in');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('.state-card h3', { hasText: /Connected, modern era/ }).waitFor({ timeout: 20_000 });
    await page.getByText(/secrets redacted: access_token/).first().waitFor({ timeout: 20_000 });
  } finally {
    await app.close();
  }
});

test('OAuth: a refused refresh on Connect says to sign in again, and offers it', async () => {
  const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_TOKEN_TTL: '1', AUTH_REFRESH: 'refuse' });
  const { dataDir } = seed([{ id: randomUUID(), name: 'expiring', transport: 'streamable-http', url }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await page.locator('.server-row', { hasText: 'expiring' }).click();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await signInFromCard(page);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('.state-card h3', { hasText: 'The sign-in has expired: sign in again' }).waitFor({ timeout: 20_000 });
    await page.locator('.state-card').getByRole('button', { name: 'Sign in again' }).waitFor();
    await shot(page, '11-2-sign-in-again');
  } finally {
    await app.close();
  }
});

// The server view's tabs: one view shown at a time, every view kept mounted,
// and the tab chosen kept when another server is chosen.
test('tabs: a half-typed call survives a switch of tab, and the tab chosen stays with the next server', async () => {
  const { dataDir } = seed([
    { id: randomUUID(), name: 'tabbed', transport: 'stdio', command: process.execPath, args: [modern], env: { CALL_TOOLS: '1' } },
    { id: randomUUID(), name: 'other', transport: 'stdio', command: process.execPath, args: [legacy] },
  ]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connect(page, 'tabbed');
    const tab = (name) => page.locator('.server-tabs').getByRole('tab', { name, exact: true });
    assert.equal(await tab('Surface').getAttribute('aria-selected'), 'true', 'opens on Surface');
    await openCall(page, 'add');
    const editor = page.locator('.call-editor textarea');
    await editor.fill('{ "a": 20 }');
    for (const name of ['Calls', 'Notifications', 'Versions']) {
      await serverTab(page, name);
      assert.equal(await page.locator('.surface').isVisible(), false, `${name} hides the surface`);
    }
    await serverTab(page, 'Surface');
    assert.equal(await editor.inputValue(), '{ "a": 20 }', 'the arguments typed are still there');
    await serverTab(page, 'Versions');
    await page.locator('.server-row', { hasText: 'other' }).click();
    await page.locator('.detail-head h2', { hasText: 'other' }).waitFor();
    assert.equal(await tab('Versions').getAttribute('aria-selected'), 'true', 'still on Versions');
    assert.ok(await page.locator('.versions').isVisible());
  } finally {
    await app.close();
  }
});

/** Drags a handle in two moves, from its middle, or from `fromTop` px below its top when its middle may be out of sight. */
async function dragBy(target, dx, dy, fromTop) {
  const page = target.page();
  const box = await target.boundingBox();
  const x = box.x + box.width / 2;
  const y = fromTop === undefined ? box.y + box.height / 2 : box.y + fromTop;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2);
  await page.mouse.move(x + dx, y + dy);
  await page.mouse.up();
}
const handle = (page, label) => page.getByRole('separator', { name: label, exact: true });

// Pane sizes: the wire log's height and the readable pane's width follow a
// drag, the log collapses to its header, and all of it survives a restart.
test('panes: the wire log and the readable pane resize by drag, the log collapses, and the sizes survive a restart', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'panes', transport: 'stdio', command: process.execPath, args: [modern] }]);
  const height = (page) => page.locator('.log-slot').evaluate((el) => el.getBoundingClientRect().height);
  const width = (page) => page.locator('.readable-pane').evaluate((el) => el.getBoundingClientRect().width);
  let grown;
  let wide;
  {
    const { app, page } = await launch(dataDir);
    try {
      await openWorkspace(page);
      await connect(page, 'panes');
      const before = await height(page);
      await dragBy(handle(page, 'Wire log height'), 0, -150);
      grown = await height(page);
      assert.ok(Math.abs(grown - (before + 150)) <= 2, `the log grew by the drag: ${before} to ${grown}`);
      const w0 = await width(page);
      await dragBy(handle(page, 'Readable pane width'), -100, 0);
      wide = await width(page);
      assert.ok(Math.abs(wide - (w0 + 100)) <= 2, `the readable pane grew by the drag: ${w0} to ${wide}`);
      await page.locator('.log-toggle').click();
      assert.equal(await height(page), 32, 'collapsed to its header');
      assert.equal(await page.locator('.wire-log .log-rows').count(), 0, 'no rows while collapsed');
      await shot(page, 'panes-collapsed');
    } finally {
      await app.close();
    }
  }
  {
    const { app, page } = await launch(dataDir);
    try {
      await openWorkspace(page);
      await page.locator('.server-row', { hasText: 'panes' }).click();
      assert.equal(await height(page), 32, 'still collapsed after a restart');
      assert.ok(Math.abs((await width(page)) - wide) <= 2, 'the readable width survived the restart');
      await page.locator('.log-toggle').click();
      assert.ok(Math.abs((await height(page)) - grown) <= 2, 'Expand restores the height it had');
    } finally {
      await app.close();
    }
  }
});

test('surface: the list is a column left of the entry; its width follows a drag and the keys, and survives a restart', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'listed', transport: 'stdio', command: process.execPath, args: [modern] }]);
  const listWidth = (page) => page.locator('.surface-items').evaluate((el) => el.getBoundingClientRect().width);
  let wide;
  {
    const { app, page } = await launch(dataDir);
    try {
      await openWorkspace(page);
      await connectAndCapture(page, 'listed', 2);
      await page.locator('.surface-items .item', { hasText: 'echo' }).click();
      await page.locator('.surface-entry .raw-viewer').waitFor();
      const list = await page.locator('.surface-items').boundingBox();
      const entry = await page.locator('.surface-entry').boundingBox();
      assert.ok(entry.x >= list.x + list.width, 'the entry sits right of the list');
      assert.ok(entry.y < list.y + list.height, 'beside it, not below it');
      const before = await listWidth(page);
      // From near its top: the main column scrolls, and the wire log covers the handle's lower part.
      await dragBy(handle(page, 'Surface list width'), 80, 0, 20);
      wide = await listWidth(page);
      assert.ok(Math.abs(wide - (before + 80)) <= 2, `dragged right, the list grew: ${before} to ${wide}`);
      await handle(page, 'Surface list width').focus();
      await page.keyboard.press('ArrowRight');
      assert.ok(Math.abs((await listWidth(page)) - (wide + 16)) <= 2, 'ArrowRight grows it, toward the entry');
      await page.keyboard.press('ArrowLeft');
      assert.ok(Math.abs((await listWidth(page)) - wide) <= 2, 'ArrowLeft takes it back');
      await shot(page, 'surface-list');
    } finally {
      await app.close();
    }
  }
  {
    const { app, page } = await launch(dataDir);
    try {
      await openWorkspace(page);
      await page.locator('.server-row', { hasText: 'listed' }).click();
      await page.locator('.surface-items').waitFor({ timeout: 20_000 });
      assert.ok(Math.abs((await listWidth(page)) - wide) <= 2, 'the list width survived the restart');
    } finally {
      await app.close();
    }
  }
});

test('surface: at the narrowest readable pane a parameter\'s type stays on one line', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'narrow', transport: 'stdio', command: process.execPath, args: [modern] }]);
  const { app, page } = await launch(dataDir);
  try {
    await openWorkspace(page);
    await connectAndCapture(page, 'narrow', 2);
    await page.locator('.surface-items .item', { hasText: 'echo' }).click();
    await handle(page, 'Readable pane width').focus();
    await page.keyboard.press('Home');
    const pane = page.locator('.readable-pane');
    assert.equal(Math.round((await pane.boundingBox()).width), 240, 'the pane is at its minimum');
    const type = pane.locator('.param-type').first();
    await type.waitFor();
    const lineHeight = await type.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 18);
    assert.ok((await type.boundingBox()).height < lineHeight * 1.5, `the type is one line, not a letter per line (${(await type.boundingBox()).height}px)`);
    await shot(page, 'params-narrow');
  } finally {
    await app.close();
  }
});

test('readable JSON: colored and pretty by default, Compact switches every block, Pretty switches back, and the choice survives a restart', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'json', transport: 'stdio', command: process.execPath, args: [modern] }]);
  const pane = (page) => page.locator('.readable-pane');
  const schema = (page) => pane(page).locator('.item-fields .json-view').first();
  {
    const { app, page } = await launch(dataDir);
    try {
      await openWorkspace(page);
      await connectAndCapture(page, 'json', 2);
      await page.locator('.surface-items .item', { hasText: 'echo' }).click();
      await schema(page).waitFor();
      assert.ok(await schema(page).locator('.j-key', { hasText: '"properties"' }).count() > 0, 'keys are colored');
      assert.ok((await schema(page).innerText()).includes('\n  "properties"'), 'pretty: indented');
      assert.equal(await pane(page).getByRole('button', { name: 'Pretty' }).getAttribute('aria-pressed'), 'true');
      await shot(page, 'json-pretty');

      await pane(page).getByRole('button', { name: 'Compact' }).click();
      assert.ok(!(await schema(page).innerText()).includes('\n'), 'compact: one line');
      assert.ok(await schema(page).locator('.j-key').count() > 0, 'still colored when compact');

      // A wire unit in the pane follows the same switch.
      await page.locator('.log-line', { hasText: 'tools/list' }).last().click();
      const unit = pane(page).locator('.json-view').first();
      await unit.waitFor();
      assert.ok(!(await unit.innerText()).includes('\n'), 'the unit is compact too');
      await pane(page).getByRole('button', { name: 'Pretty' }).click();
      assert.ok((await unit.innerText()).includes('\n  "jsonrpc"'), 'and pretty again');
      await pane(page).getByRole('button', { name: 'Compact' }).click();
    } finally {
      await app.close();
    }
  }
  {
    const { app, page } = await launch(dataDir);
    try {
      await openWorkspace(page);
      await page.locator('.server-row', { hasText: 'json' }).click();
      assert.equal(await pane(page).getByRole('button', { name: 'Compact' }).getAttribute('aria-pressed'), 'true', 'Compact survived the restart');
    } finally {
      await app.close();
    }
  }
});

test('readable JSON: text that is JSON is shown decoded in Pretty, marked, and as the plain string in Compact', async () => {
  const { dataDir } = seed([{ id: randomUUID(), name: 'embedded', transport: 'stdio', command: process.execPath, args: [legacy] }]);
  const { app, page } = await launch(dataDir);
  const pane = page.locator('.readable-pane');
  try {
    await openWorkspace(page);
    await connect(page, 'embedded');
    await openCall(page, 'echo');
    const input = page.locator('.call-form label.field', { has: page.locator('span.mono', { hasText: /^text$/ }) }).locator('input');
    await input.fill('[{"page":"claude/projects/x","score":0.4}]');
    await callConfirmed(page);
    await transcriptStatus(page, 'Completed').waitFor({ timeout: 10_000 });

    // The call's result: the text part is JSON, so Pretty shows it decoded.
    const part = pane.locator('.json-embed-part');
    await part.waitFor();
    assert.equal(await part.locator('.json-badge').innerText(), 'JSON in the text');
    assert.ok(await part.locator('.j-key', { hasText: '"page"' }).count() > 0, 'decoded keys are colored as keys');
    await shot(page, 'json-in-text');

    // The response unit in the wire log: its text field is a string holding JSON.
    await page.locator('.log-line', { hasText: 'tools/call' }).last().click();
    const unit = pane.locator('.json-view').first();
    await unit.locator('.json-embed .json-badge', { hasText: 'JSON in a string' }).waitFor();
    assert.ok((await unit.innerText()).includes('"page": "claude/projects/x"'), 'decoded and indented');
    await shot(page, 'json-in-string');

    await pane.getByRole('button', { name: 'Compact' }).click();
    assert.equal(await unit.locator('.json-embed').count(), 0, 'Compact decodes nothing');
    assert.ok((await unit.innerText()).includes('\\"page\\"'), 'the string as it is, escapes and all');
  } finally {
    await app.close();
  }
});

// --- one app per data directory ------------------------------------------------------------

/**
 * Starts the app as a person would a second time, outside playwright (which
 * waits for a window that a refused instance never opens). Resolves to its
 * exit code, or 'still running' after `ms`, when its whole tree is ended.
 */
function launchPlain(dataDir, ms = 15_000) {
  const sandbox = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
  const exe = process.env.MCPX_APP_EXE ?? createRequire(import.meta.url)('electron');
  const args = process.env.MCPX_APP_EXE ? sandbox : [repo, ...sandbox];
  const child = spawn(exe, args, { env: { ...process.env, MCPX_DATA_DIR: dataDir }, stdio: 'ignore' });
  return new Promise((resolveExit) => {
    const timer = setTimeout(async () => {
      await killProcessTree(child.pid).catch(() => undefined);
      resolveExit('still running');
    }, ms);
    child.on('exit', (code) => { clearTimeout(timer); resolveExit(code); });
  });
}

test('a second launch on the same data directory exits at once and brings the first window forward', async () => {
  const { dataDir } = seed([]);
  const first = await launch(dataDir);
  try {
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    assert.equal(await launchPlain(dataDir), 0, 'the second launch did not exit on its own');
    assert.equal(await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'the second launch opened a window in the first');
    assert.equal(await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()), false, 'the first window was not brought forward');
    await openWorkspace(first.page);
  } finally {
    await first.app.close();
  }
});

test('old valid input: a launch on another data directory runs beside the first', async () => {
  const [a, b] = [seed([]), seed([])];
  const first = await launch(a.dataDir);
  try {
    const other = await launch(b.dataDir);
    try {
      await openWorkspace(other.page);
    } finally {
      await other.app.close();
    }
  } finally {
    await first.app.close();
  }
});

test('an app that was killed leaves no lock behind: the next launch on its data directory runs', async () => {
  const { dataDir } = seed([]);
  const first = await launch(dataDir);
  const pid = first.app.process().pid;
  await killProcessTree(pid);
  assert.ok(await gone(pid), 'the first app outlived its kill');
  const next = await launch(dataDir);
  try {
    await openWorkspace(next.page);
  } finally {
    await next.app.close();
  }
});
