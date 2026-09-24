// The SDK adapter: connect to a server with the P1 seam intact and the era
// resolved, then expose it as a SurfaceSource the capture layer can walk.
//
// Everything protocol-shaped lives here so the rest of the package stays
// testable without spawning anything.
import type { Era } from './model.js';
import { eraOf } from './model.js';
import type { Page, SurfaceSource } from './capture.js';
import { StringDecoder } from 'node:string_decoder';
import { LineSplitter, SseEventSplitter, type HttpDetails, type UnitListener, type WireUnit } from './wire.js';

/**
 * Subclassing StdioClientTransport is what opts out of the SDK's disposable
 * sibling probe (D20). readStdioServerParams() treats a transport as spawnable
 * only when its IMMEDIATE prototype has an own `_dispose`; a subclass shifts
 * that prototype, so negotiation runs over the already-open process. Without
 * it, one frame per connection travels over a transport we never constructed
 * and is invisible to P1's logger, and every stdio server is spawned twice.
 *
 * This depends on an SDK internal. It is a deliberate escape hatch, not an
 * accident, but it is unversioned -- test/seam.test.mjs is what detects an
 * upgrade closing it. Never relax that assertion to make an upgrade pass.
 */
export type FrameDirection = 'out' | 'in';
export type FrameListener = (direction: FrameDirection, frame: unknown) => void;
/** Receives a FrameListener's own failure. The frame has already gone on to the SDK. */
export type FrameErrorListener = (error: unknown, direction: FrameDirection, frame: unknown) => void;

/**
 * The default for an unhandled listener failure: a process warning, so a
 * broken frame log is visible without taking the connection down with it.
 */
const warnFrameError: FrameErrorListener = (error, direction) => {
  process.emitWarning(`the frame log failed to record an ${direction} frame: ${error instanceof Error ? error.message : String(error)}`, 'MCPExplorerFrameLogWarning');
};

/** Receives a UnitListener's own failure. The bytes have already gone on. */
export type UnitErrorListener = (error: unknown, unit: WireUnit) => void;

const warnUnitError: UnitErrorListener = (error, unit) => {
  process.emitWarning(`the wire log failed to record an ${unit.direction} ${unit.kind} unit: ${error instanceof Error ? error.message : String(error)}`, 'MCPExplorerFrameLogWarning');
};

/**
 * A listener that throws must not cost the protocol its bytes, for the same
 * reason as the frame tap: the failure is reported, and the traffic goes on.
 */
function unitSink(listener: UnitListener | undefined, onError: UnitErrorListener = warnUnitError): UnitListener | undefined {
  if (!listener) return undefined;
  return (unit) => {
    try {
      listener(unit);
    } catch (error) {
      onError(error, unit);
    }
  };
}

const asBuffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);

export interface ConnectOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  clientName?: string;
  clientVersion?: string;
  /**
   * P1: receives every JSON-RPC message, negotiation included, as the SDK
   * parsed it. The wire log is onUnit; this stays as its parity check.
   */
  onFrame?: FrameListener;
  /** Receives onFrame's failures. Defaults to a process warning. */
  onFrameError?: FrameErrorListener;
  /** P1 and D34: receives every line in and out of the process and every stderr line, as exact bytes. */
  onUnit?: UnitListener;
  /** Receives onUnit's failures. Defaults to a process warning. */
  onUnitError?: UnitErrorListener;
  /** Era-probe timeout. See PROBE_TIMEOUT_MS for why the default is not the SDK's. */
  probeTimeoutMs?: number;
  /** Receives the child's stderr as text as it arrives. The stream is drained either way. */
  onStderr?: (text: string) => void;
}

/**
 * How much of the child's stderr to keep for diagnostics.
 *
 * Kept at all because a nonexistent command and a server that dies during
 * negotiation produce the SAME protocol-level error, and stderr is the only
 * thing that tells them apart. Bounded because a chatty server would otherwise
 * grow this without limit.
 */
export const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * The longest stdio line the SDK will hold before giving up on the connection:
 * its own default (STDIO_DEFAULT_MAX_BUFFER_SIZE), restated because the SDK
 * does not export it and the logging read buffer enforces the same limit.
 */
export const STDIO_MAX_LINE_BYTES = 10 * 1024 * 1024;

/**
 * Stands in for the SDK's stdio read buffer (D34). Cuts the stream into lines
 * itself, records each line's exact bytes, then hands it to the SDK's own
 * buffer, which parses it exactly as before: one complete line at a time
 * instead of a chunk at a time changes nothing it can observe.
 *
 * The SDK drops a line that is not JSON without a trace; here the line is
 * recorded first, so it reaches the log anyway. Bytes after the last newline
 * are recorded when the transport clears the buffer on close.
 */
class LoggingReadBuffer {
  private readonly lines = new LineSplitter();

  constructor(private readonly inner: any, private readonly emit: UnitListener, private readonly maxLineBytes: number) {}

  append(chunk: Buffer): void {
    for (const line of this.lines.push(chunk)) {
      this.emit({ direction: 'in', kind: 'wire', bytes: line });
      this.inner.append(asBuffer(line));
    }
    if (this.lines.pending > this.maxLineBytes) {
      this.clear();
      // The SDK's own wording for the same limit; its transport then reports
      // it and closes the connection, as it would have without this buffer.
      throw new Error(`ReadBuffer exceeded maximum size of ${this.maxLineBytes} bytes`);
    }
  }

  readMessage(): unknown {
    return this.inner.readMessage();
  }

  /** Records bytes that arrived after the last newline. Called when stdout ends and on close. */
  flushTail(): void {
    const rest = this.lines.flush();
    if (rest) this.emit({ direction: 'in', kind: 'wire', bytes: rest });
  }

  clear(): void {
    this.flushTail();
    this.inner.clear();
  }
}

/**
 * How long to wait for an era probe before concluding legacy.
 *
 * The SDK inherits its standard request timeout here, which is 60 seconds. On
 * stdio a silent server is a legacy verdict, so that is 60 seconds of nothing
 * on the FIRST connect to any server that ignores `server/discover` -- measured,
 * not guessed: the silent-probe test took 60,015 ms before this was set.
 *
 * A local process that intends to answer a single frame answers it in
 * milliseconds, so 5 seconds is generous. D20 persists the era, so even when
 * this is paid it is paid once per server rather than once per connect.
 *
 * A default, not a pillar. The cost of being wrong is asymmetric by transport:
 * on stdio a too-short timeout mislabels a slow server as legacy, and the user
 * can re-detect; on HTTP the SDK rejects the connect instead of falling back,
 * which is louder and self-correcting.
 */
export const PROBE_TIMEOUT_MS = 5000;

export interface Connection {
  era: Era;
  revision: string;
  source: SurfaceSource;
  close(): Promise<void>;
}

// D21: declaring these is what permits a server to ask for them at all. A
// server MUST NOT send an input request for a capability the client did not
// declare, so this list decides what the app can be asked to do.
const CLIENT_CAPABILITIES = { sampling: {}, elicitation: {}, roots: {} };

/**
 * The ONLY place a Client is constructed, so the P3 gate has a single site to
 * check and no second construction can quietly default to `mode: 'legacy'`.
 *
 * `negotiate: false` is the deliberate exception: after a probe has already
 * failed, the era is known to be legacy and asking for auto again would repeat
 * the probe that just cost the server its process (D20).
 */
function makeClient(
  Client: any,
  info: { name: string; version: string },
  opts: { negotiate: boolean; probeTimeoutMs?: number },
): any {
  return new Client(info, {
    capabilities: CLIENT_CAPABILITIES,
    ...(opts.negotiate
      ? { versionNegotiation: { mode: 'auto', probe: { timeoutMs: opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS } } }
      : {}),
  });
}

function tap(inner: any, listener?: FrameListener, onFrameError: FrameErrorListener = warnFrameError): any {
  if (!listener) return inner;
  // A listener that throws must not cost the protocol the frame. Called before
  // the SDK's handler, an exception here made the transport drop the message
  // (the request then hung) or reject the send; it is reported instead.
  const onFrame: FrameListener = (direction, frame) => {
    try {
      listener(direction, frame);
    } catch (error) {
      onFrameError(error, direction, frame);
    }
  };
  // What the SDK last assigned to onmessage, unwrapped. The SDK chains this
  // property: ProbeWindow saves and later restores it, and Protocol.connect()
  // reads it and installs a handler that calls what it read. Handing the SDK
  // our wrapper on read made it call the wrapper from inside the next wrapper,
  // and every inbound frame reached the log twice. The SDK reads back exactly
  // what it wrote; only the handler actually installed on the transport logs.
  let assigned: unknown;
  return new Proxy(inner, {
    get(t: any, p: string | symbol, r: unknown) {
      if (p === 'send') {
        return async (m: unknown, o?: unknown) => {
          for (const f of Array.isArray(m) ? m : [m]) onFrame('out', f);
          return t.send(m, o);
        };
      }
      if (p === 'onmessage') return assigned;
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t: any, p: string | symbol, v: unknown) {
      if (p === 'onmessage') {
        assigned = v;
        // Installed even when v is empty: a frame arriving between handlers
        // still reaches the log, though nothing else receives it.
        t.onmessage = (m: unknown, x: unknown) => { onFrame('in', m); (v as any)?.(m, x); };
        return true;
      }
      return Reflect.set(t, p, v);
    },
  });
}

/**
 * A list endpoint the server does not advertise is absent, not an error.
 *
 * Two SDK behaviours this has to account for, both measured rather than assumed:
 *
 * 1. `listTools()` and friends ALREADY walk every page internally and return
 *    the aggregate with no `nextCursor` -- 250 tools came back from one call
 *    across 36 observed `tools/list` frames. Every page still passes through
 *    the transport tap, so P1 holds. captureSurface's own page walk therefore
 *    sees a single complete page here; it remains the guarantee for any
 *    SurfaceSource that is not this SDK.
 * 2. The SDK caches cacheable results and honours the server's `ttlMs`
 *    (SEP-2549), so a second list within the TTL is served WITHOUT a round
 *    trip. That silently breaks version history: a re-capture after a
 *    `list_changed` notification would return the stale surface and the change
 *    would never be recorded. A capture must reflect the server now, so every
 *    list is issued with `cacheMode: 'bypass'`.
 */
function lister(
  client: any,
  method: 'listTools' | 'listPrompts' | 'listResources' | 'listResourceTemplates',
  field: 'tools' | 'prompts' | 'resources' | 'resourceTemplates',
  supported: boolean,
): ((cursor?: string) => Promise<Page<Record<string, unknown>>>) | undefined {
  if (!supported) return undefined;
  return async (cursor?: string) => {
    // bypass: fetch without consulting or writing the response cache. See above.
    const result = await client[method](cursor === undefined ? {} : { cursor }, { cacheMode: 'bypass' });
    return { items: (result?.[field] ?? []) as Record<string, unknown>[], nextCursor: result?.nextCursor };
  };
}

/** Everything after the transport is connected is identical across transports. */
async function describe(client: any): Promise<Connection> {
  const revision: string = client.getNegotiatedProtocolVersion?.() ?? '2025-06-18';
  const capabilities = client.getServerCapabilities?.() ?? {};
  const caps = capabilities as Record<string, unknown>;

  const source: SurfaceSource = {
    revision,
    era: eraOf(revision),
    serverInfo: client.getServerVersion?.(),
    instructions: client.getInstructions?.(),
    capabilities,
    listTools: lister(client, 'listTools', 'tools', caps.tools !== undefined),
    listPrompts: lister(client, 'listPrompts', 'prompts', caps.prompts !== undefined),
    listResources: lister(client, 'listResources', 'resources', caps.resources !== undefined),
    listResourceTemplates: lister(client, 'listResourceTemplates', 'resourceTemplates', caps.resources !== undefined),
  };
  return { era: source.era, revision, source, close: () => client.close() };
}

export type HttpTransportKind = 'streamable-http' | 'sse';

export interface HttpConnectOptions {
  url: string;
  /** SSE is the transport deprecated in 2025-03-26 and still deployed. */
  kind?: HttpTransportKind;
  clientName?: string;
  clientVersion?: string;
  /** Headers sent on every request. */
  headers?: Record<string, string>;
  /**
   * Headers sent on every request whose values are secrets. The wire log
   * records each as `<secret: name>`, never its value (D35).
   */
  secretHeaders?: Record<string, string>;
  onFrame?: FrameListener;
  onFrameError?: FrameErrorListener;
  /** P1 and D34: receives every request body, response body and SSE event, as exact bytes. */
  onUnit?: UnitListener;
  onUnitError?: UnitErrorListener;
  probeTimeoutMs?: number;
}

/**
 * Headers whose values are credentials whether or not the user marked them
 * secret. The wire log never records their values (D35).
 */
const ALWAYS_SECRET_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie'];

/** Headers as the log records them: a secret's value is replaced by its name (D35). */
function loggedHeaders(headers: HeadersInit | undefined, secretNames: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    out[name] = secretNames.has(name) || ALWAYS_SECRET_HEADERS.includes(name) ? `<secret: ${name}>` : value;
  });
  return out;
}

async function requestBytes(input: string | URL | Request, init: RequestInit | undefined): Promise<Uint8Array> {
  const body = init?.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : undefined);
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  // A stream or a Blob would have to be read to be logged, and reading it here
  // would consume what the request is about to send.
  throw new Error(`the wire log cannot record a request body of type ${Object.prototype.toString.call(body)}`);
}

/**
 * The HTTP half of the P1 seam (D34): a `fetch` that records exact bytes in
 * both directions, handed to the SDK's HTTP transports so every request they
 * make goes through it, era probe included.
 *
 * A body that is not an event stream is read whole, logged, and handed to the
 * SDK as a new Response over the same bytes, so the log holds it even when the
 * SDK refuses to read it (an HTML page, an error body, a notification's
 * acknowledgement). An event stream is passed through as it arrives, and each
 * event is logged the moment its blank line arrives, before the chunk that
 * finishes it reaches the SDK: nothing the SDK acts on is ever missing from the
 * log, and cancelling the stream still cancels the connection underneath.
 */
function loggingFetch(emit: UnitListener, secretHeaders: Iterable<string>, base: typeof fetch = fetch): typeof fetch {
  const secretNames = new Set([...secretHeaders].map((n) => n.toLowerCase()));
  let exchanges = 0;
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const exchange = ++exchanges;
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    emit({
      direction: 'out', kind: 'wire', bytes: await requestBytes(input, init),
      http: { exchange, method, url, headers: loggedHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined), secretNames) },
    });

    const response = await base(input, init);
    const http: HttpDetails = { exchange, status: response.status, statusText: response.statusText, headers: loggedHeaders(response.headers, secretNames) };
    const rebuilt = (body: BodyInit | null) => new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });

    if (!response.body) {
      emit({ direction: 'in', kind: 'wire', bytes: new Uint8Array(0), http });
      return response;
    }
    if (!/^\s*text\/event-stream\b/i.test(response.headers.get('content-type') ?? '')) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      emit({ direction: 'in', kind: 'wire', bytes, http });
      return rebuilt(bytes);
    }
    const events = new SseEventSplitter();
    const event = (bytes: Uint8Array) => emit({ direction: 'in', kind: 'wire', bytes, http: { ...http, framing: 'sse-event' } });
    const logged = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const e of events.push(chunk)) event(e);
        controller.enqueue(chunk);
      },
      flush() {
        const rest = events.flush();
        if (rest) event(rest);
      },
    }));
    return rebuilt(logged);
  };
}

export async function connectHttp(opts: HttpConnectOptions): Promise<Connection> {
  const mod: any = await import('@modelcontextprotocol/client');
  const Transport = opts.kind === 'sse' ? mod.SSEClientTransport : mod.StreamableHTTPClientTransport;
  const client = makeClient(
    mod.Client,
    { name: opts.clientName ?? 'mcp-explorer', version: opts.clientVersion ?? '0.0.0' },
    { negotiate: true, probeTimeoutMs: opts.probeTimeoutMs },
  );
  // No sibling-probe problem here: only the stdio transport spawns anything.
  // The taps are still required, or negotiation traffic bypasses P1's logger.
  const emit = unitSink(opts.onUnit, opts.onUnitError);
  const secretHeaders = opts.secretHeaders ?? {};
  const transport = new Transport(new URL(opts.url), {
    requestInit: { headers: { ...opts.headers, ...secretHeaders } },
    ...(emit ? { fetch: loggingFetch(emit, Object.keys(secretHeaders)) } : {}),
  });
  await client.connect(tap(transport, opts.onFrame, opts.onFrameError));
  return describe(client);
}

export async function connectStdio(opts: ConnectOptions): Promise<Connection> {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const Base = StdioClientTransport as unknown as new (o: unknown) => any;
  const emit = unitSink(opts.onUnit, opts.onUnitError);

  // The stdio half of the P1 seam (D34). Never define `_dispose` here: an own
  // `_dispose` on this prototype is exactly what makes the SDK spawn a sibling
  // (see the comment at the top of this file); test/seam.test.mjs asserts it.
  class SeamStdioTransport extends Base {
    constructor(o: unknown) {
      super(o);
      // Every line from the server passes through here as bytes before the
      // SDK parses it, including the lines it would drop: a banner, an HTML
      // page, a line that is not JSON at all.
      if (emit) this._readBuffer = new LoggingReadBuffer(this._readBuffer, emit, (o as { maxBufferSize?: number }).maxBufferSize ?? STDIO_MAX_LINE_BYTES);
    }

    async start(): Promise<void> {
      await super.start();
      // The SDK writes each outgoing message with one stdin.write of its
      // serialized line; recording at that call records exactly those bytes.
      if (!emit) return;
      // A server that exits on its own never makes the SDK clear its buffer,
      // so a last line without a newline is recorded when stdout ends.
      this._process?.stdout?.on('end', () => (this._readBuffer as LoggingReadBuffer).flushTail());
      const stdin = this._process?.stdin;
      if (!stdin) return;
      const write = stdin.write.bind(stdin);
      stdin.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
        emit({ direction: 'out', kind: 'wire', bytes: typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk });
        return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
      };
    }
  }

  const transportOptions = {
    command: opts.command,
    args: opts.args ?? [],
    env: opts.env ?? (process.env as Record<string, string>),
    stderr: 'pipe' as const,
  };

  // Piping stderr obliges us to READ it. An unread pipe fills at roughly 64KB
  // and the child then blocks in write() forever -- the capture hangs with no
  // error, which is worse than any diagnostic this buffer provides.
  // Read as bytes: a line the log records must be the bytes the server wrote,
  // and decoding first would replace invalid UTF-8. The text view decodes with
  // a streaming decoder, so a character split across chunks survives.
  const stderrTail = { text: '' };
  const makeTransport = () => {
    const inner = new SeamStdioTransport(transportOptions);
    const lines = new LineSplitter();
    const text = new StringDecoder('utf8');
    const stderrLine = (bytes: Uint8Array) => emit?.({ direction: 'in', kind: 'stderr', bytes });
    inner.stderr?.on('data', (chunk: Buffer) => {
      for (const line of lines.push(chunk)) stderrLine(line);
      const decoded = text.write(chunk);
      opts.onStderr?.(decoded);
      stderrTail.text = (stderrTail.text + decoded).slice(-STDERR_TAIL_BYTES);
    });
    inner.stderr?.on('end', () => {
      const rest = lines.flush();
      if (rest) stderrLine(rest);
    });
    return tap(inner, opts.onFrame, opts.onFrameError);
  };
  const withStderr = (message: string) =>
    stderrTail.text ? `${message} | server stderr: ${stderrTail.text.trim()}` : message;
  const info = { name: opts.clientName ?? 'mcp-explorer', version: opts.clientVersion ?? '0.0.0' };

  let client = makeClient(Client, info, { negotiate: true, probeTimeoutMs: opts.probeTimeoutMs });

  try {
    await client.connect(makeTransport());
  } catch (e: unknown) {
    // D20: probing in place costs the server's one process life when it is one
    // of the servers that exits on a pre-initialize request. Anything that is
    // not a clean modern answer means legacy, which is what the spec's probe
    // order already mandates -- so pin and reconnect rather than fail.
    const message = e instanceof Error ? e.message : String(e);
    if (!/negotiation failed/i.test(message)) throw new Error(withStderr(message), { cause: e });
    client = makeClient(Client, info, { negotiate: false });
    try {
      await client.connect(makeTransport());
    } catch (retry: unknown) {
      // Both attempts failed. The protocol message is identical for a command
      // that does not exist and a server that died mid-negotiation, so the
      // child's own output is what distinguishes them.
      throw new Error(withStderr(retry instanceof Error ? retry.message : String(retry)), { cause: retry });
    }
  }

  return describe(client);
}
