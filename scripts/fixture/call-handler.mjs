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

export const CALL_PROMPTS = [
  { name: 'review', description: 'Asks for a review of some code.', arguments: [{ name: 'language', required: true }, { name: 'focus', description: 'What to look at.' }] },
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
  return (msg, send) => (isCallMessage(msg) ? handleCall(msg, send, extra()) : Promise.resolve(handle(msg)));
}

/** Whether this message is one this module answers (or, for a cancellation, acts on). */
export function isCallMessage(msg) {
  if (!CALL_TOOLS_ON()) return false;
  if (msg.method === 'notifications/cancelled') return true;
  if (msg.method === 'tools/call') return TOOLS.some((t) => t.name === msg.params?.name);
  return msg.method === 'prompts/get' || msg.method === 'resources/read';
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
  const ok = (result) => ({ jsonrpc: '2.0', id, result: { ...extra, ...result } });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'prompts/get') {
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
