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
//   DIE_ON_LIST      exit instead of answering tools/list, so a session ends
//                    in the middle of a capture
//   HANG_ON_LIST     never answer tools/list, so a capture is still running
//                    when the user acts
//   HANG_ONCE_FILE   hang on tools/list only if this file does not exist yet,
//                    creating it: the first process hangs, a later one answers
//   FAIL_LIST_AFTER  answer tools/list this many times, then with an error
//   LIST_CHANGED     after answering the first tools/list, announce
//                    notifications/tools/list_changed; every later tools/list
//                    carries a second tool, and echo a second argument. Counted per process, which is per
//                    session on stdio, the only front that sends it.
//   ECHO_DESCRIPTION  echo's description (phase 09, version history)
//   SERVER_VERSION    serverInfo.version (phase 09)
//   LEGACY_REVISION   the protocolVersion initialize answers, 2025-06-18 unless
//                     set; phase 10's tasks and elicitation/complete need
//                     2025-11-25
//   EXTRAS            (extras.mjs) makes prompts and resources listable even
//                     without CALL_TOOLS, since it advertises both
//
// Returns a JSON-RPC response, `undefined` when the frame warrants none, or
// one of the two markers below; each front decides what dying or hanging
// means on its own transport.
import { existsSync, writeFileSync } from 'node:fs';
import { callTools, askTools, CALL_PROMPTS, CALL_RESOURCES, CALL_TEMPLATES, CALL_TOOLS_ON } from './call-handler.mjs';

const LISTS_ON = () => CALL_TOOLS_ON() || Boolean(process.env.EXTRAS);
const orNone = (items) => (CALL_TOOLS_ON() ? items : []);

export const DIE = Symbol('die');
export const SILENT = Symbol('silent');

let toolsListed = 0;

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export function handleLegacy(msg) {
  if (process.env.HOSTILE_PREINIT && msg.method === 'server/discover') return DIE;
  if (process.env.SILENT_PREINIT && msg.method === 'server/discover') return SILENT;

  if (msg.method === 'initialize') {
    return ok(msg.id, {
      protocolVersion: process.env.LEGACY_REVISION ?? '2025-06-18',
      capabilities: { tools: { listChanged: Boolean(process.env.LIST_CHANGED) }, ...(CALL_TOOLS_ON() ? { prompts: {}, resources: {} } : {}) },
      serverInfo: { name: 'phase00-legacy-fixture', version: process.env.SERVER_VERSION ?? '0.0.0' },
      instructions: 'Phase 00 fixture. Legacy era.',
    });
  }

  if (msg.method === 'tools/list') {
    if (process.env.DIE_ON_LIST) return DIE;
    if (process.env.HANG_ON_LIST) return SILENT;
    if (process.env.HANG_ONCE_FILE && !existsSync(process.env.HANG_ONCE_FILE)) {
      writeFileSync(process.env.HANG_ONCE_FILE, String(process.pid));
      return SILENT;
    }
    if (process.env.FAIL_LIST_AFTER && toolsListed >= Number(process.env.FAIL_LIST_AFTER)) {
      return err(msg.id, -32603, 'tools/list failed on purpose (FAIL_LIST_AFTER)');
    }
    const changed = process.env.LIST_CHANGED && toolsListed > 0;
    toolsListed++;
    return ok(msg.id, {
      tools: [{
        name: 'echo',
        description: process.env.ECHO_DESCRIPTION ?? 'Echoes its input.',
        // After the change notice echo takes a second argument too, so a form
        // open across a Refresh has a schema change to follow (R08-4).
        inputSchema: { type: 'object', properties: { text: { type: 'string' }, ...(changed ? { loud: { type: 'boolean' } } : {}) }, required: ['text'] },
      }, ...(changed ? [{ name: 'added_later', description: 'Listed after the change notice.', inputSchema: { type: 'object' } }] : []), ...callTools(), ...askTools()],
    });
  }

  if (LISTS_ON() && msg.method === 'prompts/list') return ok(msg.id, { prompts: orNone(CALL_PROMPTS) });
  if (LISTS_ON() && msg.method === 'resources/list') return ok(msg.id, { resources: orNone(CALL_RESOURCES) });
  if (LISTS_ON() && msg.method === 'resources/templates/list') return ok(msg.id, { resourceTemplates: orNone(CALL_TEMPLATES) });
  if (msg.method === 'tools/call' && msg.params?.name === 'echo') {
    const text = String(msg.params.arguments?.text ?? '');
    return ok(msg.id, { content: [{ type: 'text', text }] });
  }

  // Unknown method, including server/discover -> the probe MUST read this as legacy.
  return msg.id === undefined ? undefined : err(msg.id, -32601, `Method not found: ${msg.method}`);
}

/** Notifications to send after answering `msg`, in order. */
export function afterLegacy(msg) {
  if (process.env.LIST_CHANGED && msg.method === 'tools/list' && toolsListed === 1) {
    return [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }];
  }
  return [];
}
