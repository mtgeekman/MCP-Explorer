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
//   subscriptions  legacy: resources/subscribe and unsubscribe, and change
//                  notices sent unasked. Modern: subscriptions/listen, which
//                  acknowledges, then stays open until the client cancels it
//                  or end_listen closes it with a result; a notice goes only
//                  to a listen whose filter asked for it
//   mutate         a tool that adds the tool `mutated` to tools/list and
//                  announces tools/list_changed
//   touch          a tool that announces resources/updated for `uri`, to a
//                  subscriber of that uri only
//   end_listen     a tool that closes every open listen with its result
//   cancel_listen  a tool that ends every open listen with notifications/cancelled
//   tasks          (tasks.mjs) on modern, and on legacy at LEGACY_REVISION=2025-11-25
//   task_shaped    an ordinary result that happens to carry a `task` object
//   routed         a tool whose `region` argument declares x-mcp-header Region,
//                  answering with the arguments it got
//   MALFORMED_SURFACE  adds one deliberately malformed element of each kind the
//                  health check must flag
//                  instead, the other ending the spec describes
//
// Notices sent outside a request go through setBroadcast's writer: stdout on
// stdio, the GET event stream on legacy HTTP.
import { LEVELS } from './levels.mjs';
import { handleTask, taskTools, legacyTask, modernTask, TASK_CAPABILITIES } from './tasks.mjs';

export const EXTRAS_ON = () => Boolean(process.env.EXTRAS);

let legacyLevel;
let mutated = false;
const legacySubscriptions = new Set();
/** Open modern listens by request id: the filter and the writer of the stream they arrived on. */
const listens = new Map();
let broadcast = () => {};

/** Where a notice sent outside any request goes. Each front sets it. */
export function setBroadcast(send) { broadcast = send; }

const idKey = (id) => JSON.stringify(id);
const SUBSCRIPTION_KEY = 'io.modelcontextprotocol/subscriptionId';
const note = (method, params) => ({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });

const LANGS = ['go', 'haskell', 'javascript', 'python', 'rust', 'typescript'];

const EXTRA_TOOLS = [
  { name: 'log_burst', description: 'Sends one log message per level at or above the threshold.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'mutate', description: 'Adds a tool and announces the change.', inputSchema: { type: 'object', properties: {} } },
  { name: 'touch', description: 'Announces that a resource changed.', inputSchema: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] } },
  { name: 'end_listen', description: 'Closes every open listen with its result.', inputSchema: { type: 'object', properties: {} } },
  { name: 'cancel_listen', description: 'Ends every open listen with notifications/cancelled.', inputSchema: { type: 'object', properties: {} } },
  { name: 'task_shaped', description: 'An ordinary result that carries a field named task, as a task handle would.', inputSchema: { type: 'object', properties: {} } },
];
const MUTATED_TOOL = { name: 'mutated', description: 'Listed after mutate.', inputSchema: { type: 'object', properties: {} } };
const ROUTED_TOOL = { name: 'routed', description: 'Takes a region its server routes on.', inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, text: { type: 'string' } }, required: ['region'] }, annotations: { readOnlyHint: true } };

/** One malformed element of each kind the health check flags (MALFORMED_SURFACE). */
export const MALFORMED = {
  tools: [
    { name: 42, inputSchema: { type: 'object' } },
    { name: 'no_schema', description: 'Has no inputSchema.' },
    { name: 'bad_hint', inputSchema: { type: 'object' }, annotations: { readOnlyHint: 'yes' } },
    { name: 'bad_header', inputSchema: { type: 'object', properties: { a: { type: 'object', 'x-mcp-header': 'A' } } } },
    { name: 'bad_schema', inputSchema: { type: 'object', properties: { n: { type: 'nonsense' } } } },
  ],
  prompts: [{ name: 'bad_args', arguments: 'not a list' }],
  resources: [{ uri: 'fixture://nameless' }],
  resourceTemplates: [{ uriTemplate: 'fixture://{open', name: 'unbalanced' }],
};
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
    const err = (code, message, data) => ({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });

    if (tasksOn(era)) {
      const answered = await handleTask(era, msg, ok, err, (t) => announceTask(era, t), send);
      // null: a message handled that owes no response.
      if (answered === null) return undefined;
      if (answered !== undefined) return answered;
    }
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
    if (era === 'legacy' && (method === 'resources/subscribe' || method === 'resources/unsubscribe')) {
      if (typeof params.uri !== 'string') return err(-32602, 'uri is required');
      if (method === 'resources/subscribe') legacySubscriptions.add(params.uri); else legacySubscriptions.delete(params.uri);
      return ok({});
    }
    if (era === 'modern' && method === 'subscriptions/listen') {
      const asked = params.notifications ?? {};
      // Every kind this server has; a real server omits what it cannot honour.
      const honoured = {};
      for (const k of ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged']) if (asked[k] === true) honoured[k] = true;
      if (Array.isArray(asked.resourceSubscriptions)) honoured.resourceSubscriptions = asked.resourceSubscriptions;
      if (Array.isArray(asked.taskIds)) honoured.taskIds = asked.taskIds;
      send(note('notifications/subscriptions/acknowledged', { notifications: honoured, _meta: { [SUBSCRIPTION_KEY]: id } }));
      return new Promise((resolve) => listens.set(idKey(id), { id, filter: honoured, send, resolve }));
    }
    if (method === 'notifications/cancelled' && listens.has(idKey(params.requestId))) {
      // A cancelled listen gets no response, as the cancellation utility asks.
      const listen = listens.get(idKey(params.requestId));
      listens.delete(idKey(params.requestId));
      listen.resolve(undefined);
      return undefined;
    }
    if (method === 'tools/call' && params.name === 'mutate') {
      mutated = true;
      announce(era, 'toolsListChanged', note('notifications/tools/list_changed'));
      return ok({ content: [{ type: 'text', text: 'mutated' }] });
    }
    if (method === 'tools/call' && params.name === 'touch') {
      const uri = String(params.arguments?.uri ?? '');
      if (era === 'legacy') {
        if (legacySubscriptions.has(uri)) broadcast(note('notifications/resources/updated', { uri }));
      } else {
        for (const l of listens.values()) {
          if (l.filter.resourceSubscriptions?.includes(uri)) l.send(note('notifications/resources/updated', { uri, _meta: { [SUBSCRIPTION_KEY]: l.id } }));
        }
      }
      return ok({ content: [{ type: 'text', text: `touched ${uri}` }] });
    }
    if (method === 'tools/call' && params.name === 'end_listen') {
      const count = listens.size;
      for (const l of listens.values()) l.resolve({ jsonrpc: '2.0', id: l.id, result: { resultType: 'complete', _meta: { [SUBSCRIPTION_KEY]: l.id } } });
      listens.clear();
      return ok({ content: [{ type: 'text', text: `closed ${count}` }] });
    }
    if (method === 'tools/call' && params.name === 'cancel_listen') {
      const count = listens.size;
      for (const l of listens.values()) {
        l.send(note('notifications/cancelled', { requestId: l.id, reason: 'the fixture is shutting the stream' }));
        l.resolve(undefined);
      }
      listens.clear();
      return ok({ content: [{ type: 'text', text: `cancelled ${count}` }] });
    }
    if (method === 'tools/call' && params.name === 'routed') return ok({ content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }] });
    if (method === 'tools/call' && params.name === 'task_shaped') return ok({ content: [{ type: 'text', text: 'not a task' }], task: { taskId: 'shaped-1', status: 'completed' } });
    if (method === 'prompts/get' && params.name === 'pick') {
      return ok({ messages: [{ role: 'user', content: { type: 'text', text: `Pick ${params.arguments?.language}.` } }] });
    }

    const response = await handle(msg, send);
    return decorate(method, response, era);
  };
}

/** Legacy tasks are 2025-11-25 core; modern tasks are the extension. */
const tasksOn = (era) => era === 'modern' || process.env.LEGACY_REVISION === '2025-11-25';

/** A task's status changed: legacy notifications/tasks/status, modern notifications/tasks to listens naming it. */
function announceTask(era, t) {
  if (era === 'legacy') return broadcast(note('notifications/tasks/status', legacyTask(t)));
  for (const l of listens.values()) {
    if (l.filter.taskIds?.includes(t.id)) l.send(note('notifications/tasks', { ...modernTask(t), _meta: { [SUBSCRIPTION_KEY]: l.id } }));
  }
}

/** A change notice: unasked on legacy, and on modern only to the listens that asked for it. */
function announce(era, flag, message) {
  if (era === 'legacy') return broadcast(message);
  for (const l of listens.values()) {
    if (l.filter[flag] === true) l.send({ ...message, params: { ...(message.params ?? {}), _meta: { [SUBSCRIPTION_KEY]: l.id } } });
  }
}

/** Adds the extras to a handshake's capabilities and to each list. */
function decorate(method, response, era) {
  const result = response?.result;
  if (!result || typeof result !== 'object') return response;
  if (method === 'initialize' || method === 'server/discover') {
    const caps = result.capabilities ?? {};
    const merged = { ...caps };
    const extra = { ...CAPABILITIES, ...(tasksOn(era) ? TASK_CAPABILITIES[era] : {}) };
    for (const [k, v] of Object.entries(extra)) merged[k] = { ...(caps[k] ?? {}), ...v };
    return { ...response, result: { ...result, capabilities: merged } };
  }
  const list = LIST_EXTRAS[method];
  if (list && Array.isArray(result[list[0]]) && result.nextCursor === undefined) {
    const broken = process.env.MALFORMED_SURFACE ? MALFORMED[list[0]] : [];
    const added = [...(method === 'tools/list' ? [...list[1], ROUTED_TOOL, ...(mutated ? [MUTATED_TOOL] : []), ...(tasksOn(era) ? taskTools(era) : [])] : list[1]), ...broken];
    return { ...response, result: { ...result, [list[0]]: [...result[list[0]], ...added] } };
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
