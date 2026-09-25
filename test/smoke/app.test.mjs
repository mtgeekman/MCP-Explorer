// Phase 04 acceptance, driven through the real app with playwright-core. Run
// with `npm run test:smoke` after `npm run build`; it needs a display (CI
// runs it under xvfb on Linux). Set MCPX_APP_EXE to drive a packaged build
// instead of the built tree.
//
// Not part of `npm test`: the unit suite must never depend on a window.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { addToRegistry, createWorkspaceDb, saveServer, openWorkspaceDb } from '../../packages/storage/dist/index.js';
import { isAlive } from '../../packages/platform/dist/index.js';
import { fixtures, listen } from '../support/fixture-servers.mjs';

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
function seed(servers) {
  const dataDir = mkdtempSync(join(work, 'data-'));
  const id = randomUUID();
  const path = join(dataDir, `${id}.db`);
  const ws = createWorkspaceDb({ path, workspaceId: id, name: 'Smoke', custody: { kind: 'none' }, secrets: noSecrets });
  for (const s of servers) saveServer(ws, s);
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
