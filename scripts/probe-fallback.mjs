// Measure the seam and the spawn cost against a server that DIES on the era
// probe, alongside one that tolerates it (D20's fallback).
//
// Like probe-seam.mjs, this goes through the protocol package rather than a
// private copy of it -- see that file for why.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectStdio, captureSurface } from '../packages/protocol/dist/index.js';

const server = join(fileURLToPath(new URL('./fixture/', import.meta.url)), 'legacy-server.mjs');

async function measure(hostile) {
  const work = mkdtempSync(join(tmpdir(), 'mcpx-fb-'));
  const spawnLog = join(work, 'spawns.log');
  const frameLog = join(work, 'frames.log');
  writeFileSync(spawnLog, '');
  writeFileSync(frameLog, '');

  const sent = [];
  const conn = await connectStdio({
    command: process.execPath,
    args: [server],
    env: { ...process.env, SPAWN_LOG: spawnLog, FRAME_LOG: frameLog, ...(hostile ? { HOSTILE_PREINIT: '1' } : {}) },
    onFrame: (direction, frame) => { if (direction === 'out') sent.push(frame); },
  });
  const surface = await captureSurface(conn.source);
  await conn.close();

  const lines = (f) => readFileSync(f, 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).length;
  return {
    hostile,
    era: conn.era,
    tools: surface.tools.length,
    framesTapped: sent.length,
    framesServerReceived: lines(frameLog),
    seamComplete: sent.length === lines(frameLog),
    spawns: lines(spawnLog),
  };
}

console.log(JSON.stringify([await measure(false), await measure(true)], null, 1));
