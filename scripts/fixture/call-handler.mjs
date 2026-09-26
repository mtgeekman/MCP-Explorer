// CALL_TOOLS: the tools, prompts and resources phase 07 calls, served by
// every front of both eras. Off by default, so the surface every earlier test
// pins (and the golden context block) does not move.
//
// What each tool is for:
//   hint_*          every annotation combination the confirm gate reads (D7),
//                   including a hostile string "true" that is not read-only
//   add             a well-behaved call with structuredContent
//   wrong_shape     structuredContent that breaks its own outputSchema
//   slow            progress notifications, and it honours cancellation
//   media           every content type, and one no revision defines
//   fail            a result with isError
//   throw           a JSON-RPC error instead of a result
//   big             a text result of any size, for the 10 MB line cap
//   schema_*        input schemas the form engine must render or hand to the
//                   editor, never a third outcome (D9)
//
// Phase 08, the server asking the human for input. Modern era (MRTR_TOOLS,
// listed by the modern handler only): each answers input_required and checks
// the retry itself, so a test reads the verdict in the final result.
//   mrtr_both       sampling and form elicitation in ONE result; completes
//                   only when both keys are answered and requestState comes
//                   back exactly as issued (it holds escapes and non-ASCII)
//   mrtr_loop       asks again on every retry: the server the soft cap is for
//                   (D21). `rounds` makes it complete after that many
//   mrtr_url        URL-mode elicitation
//   mrtr_roots      a roots/list input request
//   mrtr_empty      input_required with neither field, which the spec forbids
//   mrtr_sampling_tools  sampling with tools and toolChoice (phase 10)
//   (prompt) confirm_prompt  input_required on prompts/get
// Legacy era (ASK_TOOLS, listed by the legacy handler only): each sends a
// genuine server-to-client request mid-call and answers the call with what
// the client replied, so an unanswered request leaves the call hanging.
//   ask_sampling    sampling/createMessage; `cancelAfterMs` cancels it
//   ask_elicit      elicitation/create, form mode
//   ask_elicit_url  elicitation/create, URL mode
//   ask_roots       roots/list
//   ask_twice       sampling and elicitation at once, both outstanding
//   ask_unknown     a method no revision defines
//   ask_sampling_tools  sampling/createMessage offering tools, with toolChoice
//                   (2025-11-25; phase 10)
//   ask_url_complete  URL-mode elicitation, then, once answered,
//                   notifications/elicitation/complete for it (2025-11-25)
// ROOTS_ON_INIT: a legacy server sends roots/list as soon as the client says
// it is initialized, outside any call, as real servers do.
//
// The handler is async: `send` writes a notification (progress) before the
// response. A call cancelled by notifications/cancelled is never answered, as
// the cancellation utility asks of a receiver.

export const CALL_TOOLS_ON = () => Boolean(process.env.CALL_TOOLS);

const ro = { readOnlyHint: true };
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });

/** The input schemas the form corpus test reads as well; exported for that reason. */
export const HOSTILE_SCHEMAS = {
  schema_primitives: obj({
    text: { type: 'string', description: 'Any text.', default: 'hello' },
    count: { type: 'integer', minimum: 0, maximum: 10 },
    ratio: { type: 'number' },
    flag: { type: 'boolean' },
    colour: { type: 'string', enum: ['red', 'green', 'blue'] },
    when: { type: 'string', format: 'date-time' },
  }, ['text']),
  schema_nested: obj({ outer: obj({ inner: obj({ leaf: { type: 'string' } }, ['leaf']) }) }),
  schema_array_strings: obj({ tags: { type: 'array', items: { type: 'string' } } }),
  schema_array_objects: obj({ rows: { type: 'array', items: obj({ k: { type: 'string' }, v: { type: 'number' } }) } }),
  schema_oneof: obj({ target: { oneOf: [obj({ path: { type: 'string' } }, ['path']), obj({ url: { type: 'string' } }, ['url'])] } }),
  schema_anyof_nullable: obj({ note: { anyOf: [{ type: 'string' }, { type: 'null' }] } }),
  schema_type_array: obj({ note: { type: ['string', 'null'] } }),
  schema_allof: obj({ thing: { allOf: [obj({ a: { type: 'string' } }), obj({ b: { type: 'string' } })] } }),
  schema_ref: { type: 'object', $defs: { point: obj({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']) }, properties: { at: { $ref: '#/$defs/point' } } },
  schema_additional: { type: 'object', additionalProperties: { type: 'string' } },
  schema_const: obj({ version: { const: 2 } }),
  schema_empty: { type: 'object' },
  schema_no_type: {},
  schema_not_object: { type: 'string' },
  schema_pattern_props: { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
};

const TOOLS = [
  { name: 'hint_readonly', description: 'Declares readOnlyHint true.', inputSchema: obj({}), annotations: ro },
  { name: 'hint_readonly_false', description: 'Declares readOnlyHint false.', inputSchema: obj({}), annotations: { readOnlyHint: false } },
  { name: 'hint_none', description: 'Declares no annotations at all.', inputSchema: obj({}) },
  { name: 'hint_destructive', description: 'Declares destructiveHint true.', inputSchema: obj({}), annotations: { destructiveHint: true } },
  { name: 'hint_readonly_destructive', description: 'Declares both, which contradict.', inputSchema: obj({}), annotations: { readOnlyHint: true, destructiveHint: true } },
  { name: 'hint_readonly_string', description: 'Declares readOnlyHint as the string "true".', inputSchema: obj({}), annotations: { readOnlyHint: 'true' } },
  {
    name: 'add', description: 'Adds two numbers.', annotations: ro,
    inputSchema: obj({ a: { type: 'number' }, b: { type: 'number' } }, ['a', 'b']),
    outputSchema: obj({ sum: { type: 'number' } }, ['sum']),
  },
  {
    name: 'wrong_shape', description: 'Returns structuredContent its outputSchema forbids.', annotations: ro,
    inputSchema: obj({}), outputSchema: obj({ count: { type: 'integer' } }, ['count']),
  },
  {
    name: 'slow', description: 'Reports progress, step by step. Honours cancellation.', annotations: ro,
    inputSchema: obj({ steps: { type: 'integer', minimum: 1, default: 5 }, delayMs: { type: 'integer', minimum: 0, default: 200 } }),
  },
  { name: 'media', description: 'Returns every content type, and one that no revision defines.', annotations: ro, inputSchema: obj({}) },
  { name: 'fail', description: 'Returns a result with isError.', annotations: ro, inputSchema: obj({}) },
  { name: 'throw', description: 'Answers with a JSON-RPC error.', annotations: ro, inputSchema: obj({}) },
  { name: 'big', description: 'Returns text of the size asked for.', annotations: ro, inputSchema: obj({ bytes: { type: 'integer', minimum: 0 } }, ['bytes']) },
  ...Object.entries(HOSTILE_SCHEMAS).map(([name, inputSchema]) => ({ name, description: `Echoes its arguments. Input schema: ${name}.`, annotations: ro, inputSchema })),
];

const MRTR_TOOL_LIST = [
  { name: 'mrtr_both', description: 'Asks for sampling and elicitation in one input_required result.', inputSchema: obj({ topic: { type: 'string' } }) },
  { name: 'mrtr_loop', description: 'Asks again on every retry.', inputSchema: obj({ rounds: { type: 'integer', minimum: 1 } }) },
  { name: 'mrtr_url', description: 'Asks the user to visit a URL.', inputSchema: obj({}) },
  { name: 'mrtr_roots', description: 'Asks for the client roots.', inputSchema: obj({}) },
  { name: 'mrtr_empty', description: 'Answers input_required with neither inputRequests nor requestState.', inputSchema: obj({}) },
  { name: 'mrtr_sampling_tools', description: 'Asks for sampling that may use tools.', inputSchema: obj({}) },
];

const ASK_TOOL_LIST = [
  { name: 'ask_sampling', description: 'Sends sampling/createMessage to the client mid-call.', inputSchema: obj({ cancelAfterMs: { type: 'integer', minimum: 0 } }) },
  { name: 'ask_elicit', description: 'Sends a form elicitation/create to the client mid-call.', inputSchema: obj({}) },
  { name: 'ask_elicit_url', description: 'Sends a URL-mode elicitation/create to the client mid-call.', inputSchema: obj({}) },
  { name: 'ask_roots', description: 'Sends roots/list to the client mid-call.', inputSchema: obj({}) },
  { name: 'ask_twice', description: 'Sends sampling and elicitation at once.', inputSchema: obj({}) },
  { name: 'ask_unknown', description: 'Sends a request whose method no revision defines.', inputSchema: obj({}) },
  { name: 'ask_sampling_tools', description: 'Sends sampling/createMessage offering tools.', inputSchema: obj({}) },
  { name: 'ask_url_complete', description: 'Sends URL-mode elicitation, then notifications/elicitation/complete.', inputSchema: obj({}) },
];

/** The modern-era input_required tools; the modern handler lists them. */
export const mrtrTools = () => (CALL_TOOLS_ON() ? MRTR_TOOL_LIST : []);
/** The legacy-era server-request tools; the legacy handler lists them. */
export const askTools = () => (CALL_TOOLS_ON() ? ASK_TOOL_LIST : []);

/**
 * The requestState mrtr_both issues. Escapes, a line separator and non-ASCII,
 * so a client that re-encodes or normalizes it is caught by the comparison.
 */
export const BOTH_STATE = 'both|r=1|éü中|"quoted"|back\\slash| |tab\t|end';

export const CALL_PROMPTS = [
  { name: 'review', description: 'Asks for a review of some code.', arguments: [{ name: 'language', required: true }, { name: 'focus', description: 'What to look at.' }] },
  { name: 'confirm_prompt', description: 'Answers prompts/get with input_required first (modern era).', arguments: [] },
];

export const CALL_RESOURCES = [
  { uri: 'fixture://notes/today', name: 'today', mimeType: 'text/plain' },
  { uri: 'fixture://blob/one', name: 'one', mimeType: 'application/octet-stream' },
];

export const CALL_TEMPLATES = [{ uriTemplate: 'fixture://notes/{day}', name: 'notes-by-day', mimeType: 'text/plain' }];

/** The tools this mode adds to tools/list. */
export const callTools = () => (CALL_TOOLS_ON() ? TOOLS : []);

// A 1x1 transparent PNG and a 44-byte silent WAV, the smallest real files of each.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const WAV_SILENT = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0]),
  Buffer.from('data'), Buffer.from([0, 0, 0, 0]),
]).toString('base64');

const inFlight = new Map();
const key = (id) => JSON.stringify(id);
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.onCancel = () => { clearTimeout(t); resolve(); };
});

/**
 * A front's one entry point: this module's calls when CALL_TOOLS is on,
 * otherwise the era's own handler. Always a promise. `extra` adds the era's
 * fields to every result (a modern result's resultType and _meta).
 */
export function answerer(handle, extra = () => ({})) {
  return (msg, send) => (isCallMessage(msg) ? handleCall(msg, send, extra()) : Promise.resolve(handle(msg, send)));
}

/** Whether this message is one this module answers (or, for a cancellation, acts on). */
export function isCallMessage(msg) {
  if (!CALL_TOOLS_ON()) return false;
  if (msg.method === 'notifications/cancelled') return true;
  if (msg.method === undefined && msg.id !== undefined && awaiting.has(key(msg.id))) return true;
  if (msg.method === 'notifications/initialized') return Boolean(process.env.ROOTS_ON_INIT);
  if (msg.method === 'tools/call') return [...TOOLS, ...MRTR_TOOL_LIST, ...ASK_TOOL_LIST].some((t) => t.name === msg.params?.name);
  return msg.method === 'prompts/get' || msg.method === 'resources/read';
}

// Server-to-client requests this fixture sent and is waiting on, by id.
const awaiting = new Map();
let serverRequests = 0;

/**
 * Sends a request to the client and resolves with the client's response
 * message (result or error), or with undefined once `cancelAfterMs` passes,
 * after sending notifications/cancelled for it.
 */
function ask(send, method, params, cancelAfterMs) {
  const id = `srv-${++serverRequests}`;
  return new Promise((resolve) => {
    awaiting.set(key(id), resolve);
    send({ jsonrpc: '2.0', id, method, params });
    if (cancelAfterMs !== undefined) {
      setTimeout(() => {
        if (!awaiting.delete(key(id))) return;
        send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'the fixture gave up waiting' } });
        resolve(undefined);
      }, cancelAfterMs);
    }
  });
}

const SAMPLING_PARAMS = {
  messages: [{ role: 'user', content: { type: 'text', text: 'Write one line about ports.' } }],
  systemPrompt: 'You are the fixture\'s model.',
  modelPreferences: { hints: [{ name: 'claude' }], intelligencePriority: 0.5 },
  maxTokens: 100,
};
/** Sampling that offers the model a tool and says it may choose (2025-11-25 sampling.tools). */
export const SAMPLING_WITH_TOOLS = {
  ...SAMPLING_PARAMS,
  tools: [{ name: 'lookup', description: 'Looks a word up.', inputSchema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } }],
  toolChoice: { mode: 'auto' },
};
const FORM_ELICIT = {
  message: 'Publish it?',
  requestedSchema: { type: 'object', properties: { publish: { type: 'boolean', description: 'Say yes to publish.' }, title: { type: 'string' } }, required: ['publish'] },
};
// URL mode per revision: 2025-11-25 carries an elicitationId, 2026-07-28 does not.
const URL_ELICIT_MODERN = { mode: 'url', message: 'Sign in to the fixture to continue.', url: 'https://auth.example.com/authorize?client=fixture&state=abc123' };
const URL_ELICIT = { ...URL_ELICIT_MODERN, elicitationId: 'fixture-elicit-1' };

/** The modern-era MRTR tools and prompt. Stateless: everything a retry needs is in requestState. */
function mrtr(params, ok, err) {
  const answered = params.inputResponses;
  const state = params.requestState;
  const need = (inputRequests, requestState) => ok({ resultType: 'input_required', inputRequests, requestState });
  const done = (text) => ok({ content: [{ type: 'text', text }] });
  switch (params.name) {
    case 'mrtr_both': {
      const ask2 = () => need({
        draft: { method: 'sampling/createMessage', params: SAMPLING_PARAMS },
        confirm: { method: 'elicitation/create', params: { mode: 'form', ...FORM_ELICIT } },
      }, BOTH_STATE);
      if (answered === undefined && state === undefined) return ask2();
      if (state !== BOTH_STATE) return err(-32602, `requestState came back altered: ${JSON.stringify(state)}`);
      // Partial answers are asked again, as the specification says a server should.
      if (!answered || answered.draft === undefined || answered.confirm === undefined) return ask2();
      return done(`both answered, requestState intact: ${JSON.stringify(answered)}`);
    }
    case 'mrtr_loop': {
      const round = typeof state === 'string' && state.startsWith('loop:') ? Number(state.slice(5)) : 0;
      const limit = Number.isInteger(params.arguments?.rounds) ? params.arguments.rounds : Infinity;
      if (round >= limit) return done(`finished after ${round} rounds`);
      return need({ again: { method: 'elicitation/create', params: { mode: 'form', message: `Round ${round + 1}: go again?`, requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } }, `loop:${round + 1}`);
    }
    case 'mrtr_url':
      if (!answered?.visit) return need({ visit: { method: 'elicitation/create', params: URL_ELICIT_MODERN } }, 'url:1');
      return done(`url answered: ${JSON.stringify(answered.visit)}`);
    case 'mrtr_roots':
      if (!answered?.roots) return need({ roots: { method: 'roots/list', params: {} } }, 'roots:1');
      return done(`roots answered: ${JSON.stringify(answered.roots)}`);
    case 'mrtr_empty':
      return ok({ resultType: 'input_required' });
    case 'mrtr_sampling_tools':
      if (!answered?.draft) return need({ draft: { method: 'sampling/createMessage', params: SAMPLING_WITH_TOOLS } }, 'tools:1');
      return done(`sampling answered: ${JSON.stringify(answered.draft)}`);
    default:
      return undefined;
  }
}

/** The legacy-era tools that ask the client mid-call. */
async function askTool(params, send, ok) {
  const reply = (label, response) => ok({ content: [{ type: 'text', text: `${label}: ${response === undefined ? 'cancelled by the server' : JSON.stringify(response.error ? { error: response.error } : response.result)}` }] });
  switch (params.name) {
    case 'ask_sampling': {
      const after = Number.isInteger(params.arguments?.cancelAfterMs) ? params.arguments.cancelAfterMs : undefined;
      return reply('sampling', await ask(send, 'sampling/createMessage', SAMPLING_PARAMS, after));
    }
    case 'ask_elicit':
      return reply('elicitation', await ask(send, 'elicitation/create', FORM_ELICIT));
    case 'ask_elicit_url':
      return reply('url elicitation', await ask(send, 'elicitation/create', URL_ELICIT));
    case 'ask_roots':
      return reply('roots', await ask(send, 'roots/list', {}));
    case 'ask_twice': {
      const [s, e] = await Promise.all([ask(send, 'sampling/createMessage', SAMPLING_PARAMS), ask(send, 'elicitation/create', FORM_ELICIT)]);
      return ok({ content: [{ type: 'text', text: `both: ${JSON.stringify({ sampling: s?.result ?? s?.error, elicitation: e?.result ?? e?.error })}` }] });
    }
    case 'ask_unknown':
      return reply('unknown', await ask(send, 'fixture/custom', { anything: true }));
    case 'ask_sampling_tools':
      return reply('sampling', await ask(send, 'sampling/createMessage', SAMPLING_WITH_TOOLS));
    case 'ask_url_complete': {
      const response = await ask(send, 'elicitation/create', { ...URL_ELICIT, elicitationId: 'fixture-elicit-complete' });
      // The out-of-band step finished: 2025-11-25 tells the client so.
      if (response?.result?.action === 'accept') send({ jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId: 'fixture-elicit-complete' } });
      return reply('url elicitation', response);
    }
    default:
      return undefined;
  }
}

/**
 * Answers a call. `send` writes a message ahead of the response (a progress
 * notification). Resolves to the response, or undefined when none is owed: a
 * notification, or a call that was cancelled.
 */
export async function handleCall(msg, send, extra = {}) {
  const { id, method, params = {} } = msg;
  if (method === 'notifications/cancelled') {
    const pending = inFlight.get(key(params.requestId));
    if (pending) { pending.cancelled = true; pending.onCancel?.(); }
    return undefined;
  }
  if (method === undefined) {
    // A client's response to one of this fixture's own requests.
    const resolve = awaiting.get(key(id));
    awaiting.delete(key(id));
    resolve?.(msg);
    return undefined;
  }
  if (method === 'notifications/initialized') {
    void ask(send, 'roots/list', {});
    return undefined;
  }
  const ok = (result) => ({ jsonrpc: '2.0', id, result: { ...extra, ...result } });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'tools/call') {
    const answer = mrtr(params, ok, err) ?? await askTool(params, send, ok);
    if (answer !== undefined) return answer;
  }

  if (method === 'prompts/get') {
    if (params.name === 'confirm_prompt') {
      if (!params.inputResponses?.sure) {
        return ok({ resultType: 'input_required', inputRequests: { sure: { method: 'elicitation/create', params: { mode: 'form', message: 'Get the prompt?', requestedSchema: { type: 'object', properties: {} } } } }, requestState: 'prompt:1' });
      }
      return ok({ messages: [{ role: 'user', content: { type: 'text', text: `confirmed: ${JSON.stringify(params.inputResponses.sure)}` } }] });
    }
    if (params.name !== 'review') return err(-32602, `unknown prompt ${params.name}`);
    const args = params.arguments ?? {};
    if (typeof args.language !== 'string') return err(-32602, 'missing required argument language');
    return ok({
      description: 'A review request.',
      messages: [{ role: 'user', content: { type: 'text', text: `Review this ${args.language} code${args.focus ? `, looking at ${args.focus}` : ''}.` } }],
    });
  }

  if (method === 'resources/read') {
    const uri = String(params.uri ?? '');
    if (uri === 'fixture://blob/one') return ok({ contents: [{ uri, mimeType: 'application/octet-stream', blob: Buffer.from([0, 1, 2, 250]).toString('base64') }] });
    const day = /^fixture:\/\/notes\/([^/]+)$/.exec(uri)?.[1];
    if (!day) return err(-32002, `resource not found: ${uri}`);
    return ok({ contents: [{ uri, mimeType: 'text/plain', text: `Notes for ${decodeURIComponent(day)}.` }] });
  }

  const args = params.arguments ?? {};
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  switch (params.name) {
    case 'add': {
      const sum = Number(args.a) + Number(args.b);
      return ok({ ...text(String(sum)), structuredContent: { sum } });
    }
    case 'wrong_shape':
      return ok({ ...text('three'), structuredContent: { count: 'three' } });
    case 'slow': {
      const steps = Number.isInteger(args.steps) && args.steps > 0 ? args.steps : 5;
      const delayMs = Number.isInteger(args.delayMs) && args.delayMs >= 0 ? args.delayMs : 200;
      const token = params._meta?.progressToken;
      const pending = { cancelled: false };
      inFlight.set(key(id), pending);
      try {
        for (let i = 1; i <= steps; i++) {
          await sleep(delayMs, pending);
          if (pending.cancelled) return undefined;
          if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: i, total: steps, message: `step ${i} of ${steps}` } });
        }
        return ok(text(`done after ${steps} steps`));
      } finally {
        inFlight.delete(key(id));
      }
    }
    case 'media':
      return ok({
        content: [
          { type: 'text', text: 'Every kind of content follows.' },
          { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
          { type: 'audio', data: WAV_SILENT, mimeType: 'audio/wav' },
          { type: 'resource', resource: { uri: 'fixture://notes/embedded', mimeType: 'text/plain', text: 'An embedded resource.' } },
          { type: 'resource_link', uri: 'fixture://notes/today', name: 'today', mimeType: 'text/plain' },
          { type: 'hologram', data: 'no revision defines this type' },
        ],
      });
    case 'fail':
      return ok({ ...text('The tool ran and reports failure.'), isError: true });
    case 'throw':
      return err(-32603, 'The tool threw on purpose.');
    case 'big':
      return ok(text('x'.repeat(Math.max(0, Number(args.bytes) || 0))));
    default:
      return ok(text(JSON.stringify(args)));
  }
}
