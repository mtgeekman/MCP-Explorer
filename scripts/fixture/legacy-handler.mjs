// The legacy-era (initialize handshake, 2025-06-18 shaped) response logic,
// shared by every transport, as modern-handler.mjs is for the modern era.
// Hand-rolled on purpose: the tests count frames, so nothing between us and
// the wire may be a variable.
//
// Hostile modes that model real legacy servers meeting a modern client:
//   HOSTILE_PREINIT  die on any pre-initialize request (the hazard the SDK's
//                    disposable sibling probe exists to absorb)
//   SILENT_PREINIT   never answer the probe at all; the spec says a timeout
//                    is a legacy signal just as much as -32601 is
//
// Returns a JSON-RPC response, `undefined` when the frame warrants none, or
// one of the two markers below; each front decides what dying or hanging
// means on its own transport.
export const DIE = Symbol('die');
export const SILENT = Symbol('silent');

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export function handleLegacy(msg) {
  if (process.env.HOSTILE_PREINIT && msg.method === 'server/discover') return DIE;
  if (process.env.SILENT_PREINIT && msg.method === 'server/discover') return SILENT;

  if (msg.method === 'initialize') {
    return ok(msg.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'phase00-legacy-fixture', version: '0.0.0' },
      instructions: 'Phase 00 fixture. Legacy era.',
    });
  }

  if (msg.method === 'tools/list') {
    return ok(msg.id, {
      tools: [{
        name: 'echo',
        description: 'Echoes its input.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }],
    });
  }

  // Unknown method, including server/discover -> the probe MUST read this as legacy.
  return msg.id === undefined ? undefined : err(msg.id, -32601, `Method not found: ${msg.method}`);
}
