// The modern-era (2026-07-28) response logic, shared by every transport.
//
// Extracted so stdio, Streamable HTTP and SSE serve the SAME surface. The
// acceptance criterion is that a capture is identical across all three, and
// three hand-written copies could not prove that -- they would only prove the
// three copies agreed.
//
// Deliberate hostility, each thing the client must cope with:
//   - tools returned in shuffled order, with shuffled JSON keys
//   - ttlMs and cacheScope CHANGING ON EVERY RESPONSE
//   - serverInfo in _meta rather than the result body
//   - capabilities that can be made to lie (LIE_ABOUT)
//   - a first probe that can answer -32022 (UNSUPPORTED_FIRST)

let probed = false;

const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(([, v]) => v);
const shuffleKeys = (o) =>
  Array.isArray(o) ? o.map(shuffleKeys)
  : o && typeof o === 'object' ? Object.fromEntries(shuffle(Object.entries(o)).map(([k, v]) => [k, shuffleKeys(v)]))
  : o;

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

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });

/** Returns a JSON-RPC response, or undefined when the frame warrants none. */
export function handleModern(msg) {
  const { id, method, params = {} } = msg;
  const lies = (process.env.LIE_ABOUT ?? '').split(',').filter(Boolean);

  if (method === 'server/discover') {
    if (process.env.UNSUPPORTED_FIRST && !probed) {
      probed = true;
      // A recognised MODERN error: the spec says retry with data.supported,
      // and explicitly NOT that this is a legacy signal.
      return err(id, -32022, 'Unsupported protocol version', {
        supported: ['2026-07-28'],
        requested: params?._meta?.['io.modelcontextprotocol/protocolVersion'],
      });
    }
    return ok(id, shuffleKeys({
      resultType: 'complete',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: 'Phase 01 fixture. Modern era.',
      ...serverMeta(),
      ...volatile(),
    }));
  }

  if (method === 'prompts/list' && lies.includes('prompts')) return err(id, -32601, 'Method not found: prompts/list');
  if (method === 'resources/list' && lies.includes('resources')) return err(id, -32601, 'Method not found: resources/list');

  if (method === 'tools/list') {
    const total = Number(process.env.TOOL_COUNT ?? 0);
    if (total > 0) {
      const size = Number(process.env.PAGE_SIZE ?? 10);
      const start = params.cursor ? Number(params.cursor) : 0;
      const page = Array.from({ length: Math.min(size, total - start) }, (_, i) => ({
        name: `tool-${start + i}`,
        description: `Synthetic tool ${start + i}.`,
        inputSchema: { type: 'object', properties: {} },
      }));
      const next = start + size;
      return ok(id, shuffleKeys({
        resultType: 'complete',
        tools: shuffle(page.map(shuffleKeys)),
        ...(next < total ? { nextCursor: String(next) } : {}),
        ...serverMeta(),
        ...volatile(),
      }));
    }
    return ok(id, shuffleKeys({ resultType: 'complete', tools: shuffle(TOOLS.map(shuffleKeys)), ...serverMeta(), ...volatile() }));
  }

  if (method === 'prompts/list') {
    return ok(id, shuffleKeys({
      resultType: 'complete',
      prompts: [{ name: 'greet', title: 'Greet', description: 'A greeting.', arguments: [{ name: 'who', required: true }] }].map(shuffleKeys),
      ...serverMeta(), ...volatile(),
    }));
  }

  if (method === 'resources/list') {
    return ok(id, shuffleKeys({
      resultType: 'complete',
      resources: [{ uri: 'file:///fixture/readme.md', name: 'readme', title: 'Readme', mimeType: 'text/markdown' }].map(shuffleKeys),
      ...serverMeta(), ...volatile(),
    }));
  }

  if (method === 'resources/templates/list') {
    return ok(id, shuffleKeys({
      resultType: 'complete',
      resourceTemplates: [{ uriTemplate: 'file:///fixture/{name}.md', name: 'doc', mimeType: 'text/markdown' }].map(shuffleKeys),
      ...serverMeta(), ...volatile(),
    }));
  }

  if (method === 'tools/call') {
    if (params.name === 'needs_input') {
      const answered = params._meta?.inputResponses ?? params.inputResponses;
      if (!answered) {
        return ok(id, {
          resultType: 'input_required',
          requestState: 'opaque-state-do-not-touch',
          inputRequests: {
            who: { method: 'elicitation/create', params: { mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
          },
          ...serverMeta(),
        });
      }
      return ok(id, { resultType: 'complete', content: [{ type: 'text', text: `got input: ${JSON.stringify(answered)}` }], ...serverMeta() });
    }
    return ok(id, {
      resultType: 'complete',
      content: [{ type: 'text', text: String(params.arguments?.text ?? '') }],
      structuredContent: { text: String(params.arguments?.text ?? '') },
      ...serverMeta(),
    });
  }

  return id === undefined ? undefined : err(id, -32601, `Method not found: ${method}`);
}
