// Screenshots of the app for the README, taken from the built tree against
// real published servers fetched with npx (network needed):
// `npm run build`, then `node scripts/screenshots.mjs [outDir]`
// (default docs/screenshots). The servers are pinned, so a rerun shows the
// same surfaces. Selectors are the smoke tests'; a step that breaks says which.
import { _electron as electron } from 'playwright-core';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { addToRegistry, createWorkspaceDb, saveServer, recordCapture } from '../packages/storage/dist/index.js';
import { connectStdio, captureSurface } from '../packages/protocol/dist/index.js';

const repo = resolve(fileURLToPath(new URL('../', import.meta.url)));
const out = resolve(process.argv[2] ?? join(repo, 'docs', 'screenshots'));
const noSecrets = { get: () => null, set: () => { throw new Error('unencrypted workspace'); }, delete: () => false };
const work = mkdtempSync(join(tmpdir(), 'mcpx-shots-'));
mkdirSync(out, { recursive: true });

const EVERYTHING = '@modelcontextprotocol/server-everything';
const MEMORY = '@modelcontextprotocol/server-memory@2.0.1';
const npx = (pkg) => ({ command: 'npx', args: ['-y', pkg] });

async function capture(pkg) {
  const conn = await connectStdio({ ...npx(pkg), probeTimeoutMs: 15_000 });
  try { return await captureSurface(conn.source); } finally { await conn.close(); }
}

const day = 86_400_000;
const everythingId = randomUUID();
const servers = [
  { id: everythingId, name: 'everything', transport: 'stdio', ...npx(`${EVERYTHING}@2.1.0`) },
  // The memory server keeps its graph in a file: here, one that goes with this run.
  { id: randomUUID(), name: 'memory', transport: 'stdio', ...npx(MEMORY), env: { MEMORY_FILE_PATH: join(work, 'memory.jsonl') } },
];
// The release before, as an earlier session would have captured it.
const captures = [[everythingId, await capture(`${EVERYTHING}@2.0.1`), Date.now() - 3 * day]];

const dataDir = join(work, 'data');
mkdirSync(dataDir);
const wsId = randomUUID();
const wsPath = join(dataDir, `${wsId}.db`);
const ws = createWorkspaceDb({ path: wsPath, workspaceId: wsId, name: 'Demo', custody: { kind: 'none' }, secrets: noSecrets });
for (const s of servers) saveServer(ws, s);
for (const [serverId, surface, at] of captures) recordCapture(ws, serverId, surface, { now: () => at });
ws.close();
addToRegistry(join(dataDir, 'workspaces.json'), { id: wsId, path: wsPath, custody: 'none', createdAt: Date.now(), name: 'Demo' });

const sandbox = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
const app = await electron.launch({ args: [repo, ...sandbox], env: { ...process.env, MCPX_DATA_DIR: dataDir } });
const page = await app.firstWindow();
await page.setViewportSize({ width: 1600, height: 1000 });

let step = 'start';
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: join(out, `${name}.png`) }); console.log(`wrote ${name}.png`); };
const top = (locator) => locator.first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
const serverTab = (name) => page.locator('.server-tabs').getByRole('tab', { name, exact: true }).click();
const entryTab = (name) => page.locator('.surface-entry .tabs').getByRole('tab', { name, exact: true }).click();
const callButton = () => page.locator('.call-form-view > .actions').getByRole('button', { name: 'Call', exact: true });
const transcriptStatus = (text) => page.locator('.call-panel .transcript .call-status', { hasText: text });
const wireLog = (state) => page.locator('button', { hasText: state === 'collapse' ? /^Collapse$/ : /^Expand$/ }).first().click();

async function connect(name) {
  await page.locator('.server-row', { hasText: name }).click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('.state-card h3', { hasText: /Connected, (modern|legacy) era/ }).waitFor({ timeout: 120_000 });
  await page.locator('.surface-items .item').first().waitFor({ timeout: 30_000 });
}
async function disconnect() {
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.locator('.state-card h3', { hasText: 'Stopped' }).waitFor({ timeout: 30_000 });
}
async function openEntry(tool) {
  await page.locator('.surface-items button', { hasText: new RegExp(`^${tool}`) }).first().click();
}

try {
  step = 'open the workspace';
  await page.getByText('Demo').first().click();
  await page.locator('.server-list').waitFor();

  step = 'surface';
  await connect('everything');
  await openEntry('get-structured-content');
  await page.locator('.entry-source', { hasText: 'Exact bytes from wire log unit' }).waitFor();
  await top(page.locator('.server-tabs'));
  await shot('01-surface-and-wire-log');

  step = 'call';
  await wireLog('collapse');
  await entryTab('Call');
  await page.locator('.call-editor textarea').fill('{ "location": "New York" }');
  await callButton().click();
  await transcriptStatus('Completed').waitFor({ timeout: 30_000 });
  await top(page.locator('.server-tabs'));
  await shot('02-call-result');

  step = 'confirm';
  await openEntry('trigger-elicitation-request');
  await entryTab('Call');
  await callButton().click();
  await page.locator('.modal').waitFor();
  await shot('03-confirm');

  step = 'input request';
  await page.locator('.modal').getByRole('button', { name: 'Send', exact: true }).click();
  await transcriptStatus('Waiting for input').waitFor({ timeout: 30_000 });
  const card = page.locator('.input-card').first();
  await card.waitFor();
  await card.getByRole('radio', { name: 'Accept with these values' }).check();
  await card.locator('input[type="text"], input:not([type])').first().fill('Ada Lovelace');
  await top(page.locator('.call-panel .transcript .call-status', { hasText: 'Waiting for input' }));
  await shot('04-input-request');
  await disconnect();

  step = 'versions';
  await serverTab('Versions');
  const rows = page.locator('.versions-table tr');
  await rows.nth(1).waitFor({ timeout: 30_000 });
  await rows.nth(0).click();
  const diff = page.locator('.version-diff');
  await diff.locator('.diff-line').first().waitFor();
  await top(page.locator('.versions-table'));
  await shot('05-versions');
  await serverTab('Surface');

  step = 'context';
  await connect('memory');
  await disconnect();
  await page.getByRole('button', { name: 'Context', exact: true }).click();
  await page.locator('.context-total').waitFor();
  await shot('06-context');
} catch (e) {
  console.error(`failed at step "${step}": ${e instanceof Error ? e.message : String(e)}`);
  await page.screenshot({ path: join(out, '_failure.png') }).catch(() => undefined);
  console.error(`the window at the failure: ${join(out, '_failure.png')}`);
  process.exitCode = 1;
} finally {
  await app.close();
  rmSync(work, { recursive: true, force: true });
}
