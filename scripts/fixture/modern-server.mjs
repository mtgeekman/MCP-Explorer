// MODERN-era fixture MCP server (2026-07-28) over stdio.
//
// The counterpart to legacy-server.mjs. Hand-rolled for the same reason: the
// tests count frames and assert exact shapes, so nothing may sit between the
// test and the wire.
//
// Deliberate properties, each one something the client must cope with:
//   - server/discover instead of initialize; no initialize handler at all
//   - every result carries resultType; cacheable results carry ttlMs/cacheScope
//   - ttlMs and cacheScope CHANGE ON EVERY RESPONSE, so a capture that hashes
//     them produces a new surface version on every connect
//   - tools are returned in shuffled order with shuffled JSON keys
//   - serverInfo lives in _meta, not the result body
import { appendFileSync } from 'node:fs';
import { readFrames, writer } from './stdio-lines.mjs';

const spawnLog = process.env.SPAWN_LOG;
if (spawnLog) appendFileSync(spawnLog, `${Date.now()} pid=${process.pid}\n`);

const { reply, fail } = writer(process.stdout);
const log = (line) => { if (process.env.FRAME_LOG) appendFileSync(process.env.FRAME_LOG, `IN  ${line}\n`); };

const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(([, v]) => v);
const shuffleKeys = (o) =>
  Array.isArray(o) ? o.map(shuffleKeys)
  : o && typeof o === 'object' ? Object.fromEntries(shuffle(Object.entries(o)).map(([k, v]) => [k, shuffleKeys(v)]))
  : o;

// Volatile by design: required on every cacheable result and server-chosen, so
// they are exactly what an allowlist canonicalization must refuse to hash.
const volatile = () => ({ ttlMs: 1000 + Math.floor(Math.random() * 60000), cacheScope: Math.random() < 0.5 ? 'public' : 'private' });
const serverMeta = () => ({ _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'phase01-modern-fixture', version: '0.0.0' } } });

const TOOLS = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echoes its input.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to echo.' } }, required: ['text'] },
    outputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'needs_input',
    title: 'Needs input',
    description: 'Always answers with an InputRequiredResult, to exercise MRTR.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false },
  },
];

readFrames(process.stdin, (msg, line) => {
  log(line);
  const { id, method, params = {} } = msg;

  if (method === 'server/discover') {
    return reply(id, shuffleKeys({
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: 'Phase 01 fixture. Modern era.',
      ...serverMeta(),
      ...volatile(),
    }));
  }

  if (method === 'tools/list') {
    return reply(id, shuffleKeys({
      resultType: 'complete',
      tools: shuffle(TOOLS.map(shuffleKeys)),
      ...serverMeta(),
      ...volatile(),
    }));
  }

  if (method === 'tools/call') {
    if (params.name === 'needs_input') {
      // MRTR: ask for input rather than answering, unless the retry carries it.
      const answered = params._meta?.inputResponses ?? params.inputResponses;
      if (!answered) {
        return reply(id, {
          resultType: 'input_required',
          requestState: 'opaque-state-do-not-touch',
          inputRequests: {
            who: { method: 'elicitation/create', params: { mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
          },
          ...serverMeta(),
        });
      }
      return reply(id, { resultType: 'complete', content: [{ type: 'text', text: `got input: ${JSON.stringify(answered)}` }], ...serverMeta() });
    }
    return reply(id, {
      resultType: 'complete',
      content: [{ type: 'text', text: String(params.arguments?.text ?? '') }],
      structuredContent: { text: String(params.arguments?.text ?? '') },
      ...serverMeta(),
    });
  }

  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
});
