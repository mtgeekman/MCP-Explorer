// Measure the P1 seam and the era-probe spawn cost on the REAL code path.
//
// This used to build its own Client and its own transport tap -- a copy of
// connectStdio. A measurement tool that measures a copy is worthless: it can
// report a healthy seam while the app's actual client leaks frames. It now goes
// through the protocol package, so what it prints is what the app does.
//
// The comparison against the SDK's default (disposable sibling probe, one frame
// invisible, two spawns) lives in test/seam.test.mjs, which mutates the
// subclass away deliberately. It is not reproduced here, because doing so would
// mean constructing a second Client outside the transport layer -- exactly what
// P1's build gate forbids.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectStdio, captureSurface } from '../packages/protocol/dist/index.js';

const fixtures = fileURLToPath(new URL('./fixture/', import.meta.url));
const server = join(fixtures, process.argv[2] ?? 'legacy-server.mjs');

const work = mkdtempSync(join(tmpdir(), 'mcpx-probe-'));
const spawnLog = join(work, 'spawns.log');
const frameLog = join(work, 'frames.log');
writeFileSync(spawnLog, '');
writeFileSync(frameLog, '');

const frames = { out: [], in: [] };
const conn = await connectStdio({
  command: process.execPath,
  args: [server],
  env: { ...process.env, SPAWN_LOG: spawnLog, FRAME_LOG: frameLog },
  onFrame: (direction, frame) => frames[direction].push(frame),
});
const surface = await captureSurface(conn.source);
await conn.close();

const lines = (f) => readFileSync(f, 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).length;

console.log(JSON.stringify({
  server: process.argv[2] ?? 'legacy-server.mjs',
  era: conn.era,
  revision: conn.revision,
  tools: surface.tools.length,
  framesTapped: frames.out.length,
  framesServerReceived: lines(frameLog),
  seamComplete: frames.out.length === lines(frameLog),
  serverProcessSpawns: lines(spawnLog),
  outboundMethods: frames.out.map((f) => f.method).filter(Boolean),
}, null, 1));
