// EXTRAS: the phase 10 surfaces, served on both eras by wrapping an era's
// handler. Off by default, so every earlier pin (and the golden context block)
// stays where it was.
//
// What it adds, per era:
//   capabilities   logging, completions, resources.subscribe and listChanged,
//                  and listChanged on tools and prompts
//   ping           legacy only; the modern handler still answers -32601
//   logging        legacy: logging/setLevel sets the threshold for the whole
//                  session, unset until the client asks. Modern: the threshold
//                  is each request's _meta logLevel, and no key means no
//                  messages (2026-07-28, "Per-request log level")
//   completion     completion/complete for the prompt `pick` (argument
//                  `language`) and the template `fixture://langs/{lang}`
//   log_burst      a tool that sends one notifications/message per level at
//                  or above the threshold, then answers with how many it sent
//   pick           a prompt with a completable argument
//   resources      one resource carrying size and annotations, one template
//                  carrying annotations (decision 9)
import { LEVELS } from './levels.mjs';

export const EXTRAS_ON = () => Boolean(process.env.EXTRAS);

let legacyLevel;

const LANGS = ['go', 'haskell', 'javascript', 'python', 'rust', 'typescript'];

const EXTRA_TOOLS = [
  { name: 'log_burst', description: 'Sends one log message per level at or above the threshold.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
];
const EXTRA_PROMPTS = [{ name: 'pick', description: 'A prompt whose argument completes.', arguments: [{ name: 'language', required: true }] }];
const EXTRA_RESOURCES = [{ uri: 'fixture://sized', name: 'sized', mimeType: 'text/plain', size: 42, annotations: { audience: ['user'], priority: 0.5 } }];
const EXTRA_TEMPLATES = [{ uriTemplate: 'fixture://langs/{lang}', name: 'langs', annotations: { audience: ['assistant'] } }];

const LIST_EXTRAS = { 'tools/list': ['tools', EXTRA_TOOLS], 'prompts/list': ['prompts', EXTRA_PROMPTS], 'resources/list': ['resources', EXTRA_RESOURCES], 'resources/templates/list': ['resourceTemplates', EXTRA_TEMPLATES] };

const CAPABILITIES = {
  logging: {},
  completions: {},
  tools: { listChanged: true },
  prompts: { listChanged: true },
  resources: { subscribe: true, listChanged: true },
};

/**
 * Wraps an era's handler with the extras. `era` picks the per-era behaviour;
 * `extra` adds that era's fields to every result the extras produce.
 */
export function withExtras(handle, era, extra = () => ({})) {
  if (!EXTRAS_ON()) return handle;
  return async (msg, send) => {
    const { id, method, params = {} } = msg;
    const ok = (result) => ({ jsonrpc: '2.0', id, result: { ...extra(), ...result } });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

    if (era === 'legacy' && method === 'ping') return ok({});
    if (era === 'legacy' && method === 'logging/setLevel') {
      if (!LEVELS.includes(params.level)) return err(-32602, `unknown level ${JSON.stringify(params.level)}`);
      legacyLevel = params.level;
      return ok({});
    }
    if (method === 'completion/complete') return ok({ completion: complete(params) });
    if (method === 'tools/call' && params.name === 'log_burst') {
      const threshold = era === 'legacy' ? legacyLevel : params._meta?.['io.modelcontextprotocol/logLevel'];
      const levels = threshold === undefined ? [] : LEVELS.slice(LEVELS.indexOf(threshold));
      for (const level of levels) send({ jsonrpc: '2.0', method: 'notifications/message', params: { level, logger: 'fixture', data: `a ${level} message` } });
      return ok({ content: [{ type: 'text', text: `sent ${levels.length} messages` }] });
    }
    if (method === 'prompts/get' && params.name === 'pick') {
      return ok({ messages: [{ role: 'user', content: { type: 'text', text: `Pick ${params.arguments?.language}.` } }] });
    }

    const response = await handle(msg, send);
    return decorate(method, response);
  };
}

/** Adds the extras to a handshake's capabilities and to each list. */
function decorate(method, response) {
  const result = response?.result;
  if (!result || typeof result !== 'object') return response;
  if (method === 'initialize' || method === 'server/discover') {
    const caps = result.capabilities ?? {};
    const merged = { ...caps };
    for (const [k, v] of Object.entries(CAPABILITIES)) merged[k] = { ...(caps[k] ?? {}), ...v };
    return { ...response, result: { ...result, capabilities: merged } };
  }
  const list = LIST_EXTRAS[method];
  if (list && Array.isArray(result[list[0]]) && result.nextCursor === undefined) {
    return { ...response, result: { ...result, [list[0]]: [...result[list[0]], ...list[1]] } };
  }
  return response;
}

function complete(params) {
  const ref = params.ref ?? {};
  const value = String(params.argument?.value ?? '');
  const known = (ref.type === 'ref/prompt' && ref.name === 'pick' && params.argument?.name === 'language')
    || (ref.type === 'ref/resource' && ref.uri === 'fixture://langs/{lang}' && params.argument?.name === 'lang');
  const values = known ? LANGS.filter((l) => l.startsWith(value)) : [];
  return { values, total: values.length, hasMore: false };
}
