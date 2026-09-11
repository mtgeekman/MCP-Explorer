// Build gates for the pillars. These assert properties of the SOURCE, not of a
// running session, because the defects they prevent are introduced by editing
// and would otherwise only show up as a subtly wrong session much later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function sources(dir, acc = []) {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    if (statSync(join(root, rel)).isDirectory()) sources(rel, acc);
    else if (/\.(ts|mjs)$/.test(entry)) acc.push(rel);
  }
  return acc;
}

// The one module allowed to speak JSON-RPC: it owns the transport and the tap.
const TRANSPORT_LAYER = ['packages/protocol/src/client.ts'];
// Fixtures are SERVERS. They exist to put frames on the wire for the client to
// read, so the client-side rule does not apply to them.
const FIXTURES = 'scripts/fixture/';

test('P1: no module outside the transport layer constructs a JSON-RPC frame', () => {
  const offenders = [];
  for (const file of [...sources('packages'), ...sources('src')]) {
    if (TRANSPORT_LAYER.includes(file)) continue;
    const text = readFileSync(join(root, file), 'utf8');
    // A frame is identified by its envelope; nothing else in this codebase has
    // a reason to write one.
    if (/jsonrpc\s*:\s*['"]2\.0['"]/.test(text)) offenders.push(`${file}: constructs a jsonrpc envelope`);
    if (/\.send\s*\(\s*\{[^}]*jsonrpc/.test(text)) offenders.push(`${file}: sends a raw frame`);
  }
  assert.deepEqual(offenders, [], `frames must be constructed only in ${TRANSPORT_LAYER.join(', ')}`);
});

test('P1: the transport tap is not bypassed by a second client construction', () => {
  // Every Client must be built where the tap is applied. A Client constructed
  // elsewhere would talk to a server with nothing logging it.
  const offenders = [];
  for (const file of [...sources('packages'), ...sources('src')]) {
    if (TRANSPORT_LAYER.includes(file)) continue;
    const text = readFileSync(join(root, file), 'utf8');
    if (/new\s+(mod\.)?Client\s*\(/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'a Client built outside the transport layer is unlogged');
});

test('P3: there is one Client construction site, and it can negotiate', () => {
  // The package default is 'legacy'. A Client built without the override never
  // tries the modern era, and the failure is silent: everything works and
  // 2026-07-28 servers are simply invisible. Rather than parse every call site,
  // the source keeps exactly ONE, so this gate checks that it stays one.
  const text = readFileSync(join(root, TRANSPORT_LAYER[0]), 'utf8');
  const sites = text.match(/new Client\(/g) ?? [];
  assert.equal(sites.length, 1, `expected exactly one Client construction, found ${sites.length}`);
  assert.ok(text.includes("versionNegotiation: { mode: 'auto'"), 'the construction site cannot negotiate');
});

test('the fixtures are servers, and are deliberately outside the frame rule', () => {
  // Guard the guard: if the fixtures ever stop constructing frames, the
  // exemption above is stale and should be deleted rather than left standing.
  const text = readFileSync(join(root, FIXTURES, 'stdio-lines.mjs'), 'utf8');
  assert.match(text, /jsonrpc/, 'fixtures no longer write frames; the exemption is dead');
});
