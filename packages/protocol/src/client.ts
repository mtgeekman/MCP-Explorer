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
 * accident, but it is unversioned -- test/seam.test.mjs and test/wire-tap.test.mjs detect an
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
  cwd?: string;
  /** `legacy` for a server pinned as legacy (D20): no probe. Default `auto`. */
  era?: EraPreference;
  /** Called once when a connected session ends, for any reason, with how the process exited. */
  onClose?: (info: CloseInfo) => void;
  /**
   * Ends the spawned process and everything it started, for a connect that
   * fails with the server still running. Without it the SDK's close() is used,
   * which signals the spawned process alone.
   */
  terminate?: (pid: number) => Promise<void>;
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
 * can re-detect; on HTTP connectHttp falls back to legacy itself (the SDK
 * would reject), and a modern server mislabelled that way answers the
 * legacy initialize with -32022, which re-probes on its own.
 */
export const PROBE_TIMEOUT_MS = 5000;

export interface Connection {
  era: Era;
  revision: string;
  source: SurfaceSource;
  /** stdio only: the process the app spawned, the root of its tree (D36). */
  pid?: number;
  /** stdio only: when that process was seen to spawn, milliseconds since the epoch. */
  startedAt?: number;
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
 * `negotiate: false` is the deliberate exception: a server whose era is pinned
 * as legacy gets `initialize` with no probe, since the probe may be what cost
 * it its process before (D20).
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
  /** `legacy` for a server pinned as legacy (D20): no probe. Default `auto`. */
  era?: EraPreference;
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

/**
 * A request body's bytes, or the body's type when they cannot be had: a
 * stream or a Blob would have to be read to be logged, and reading it here
 * would consume what the request is about to send.
 */
async function requestBytes(input: string | URL | Request, init: RequestInit | undefined): Promise<Uint8Array | { unrecorded: string }> {
  const body = init?.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : undefined);
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  return { unrecorded: Object.prototype.toString.call(body) };
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
export function loggingFetch(emit: UnitListener, secretHeaders: Iterable<string>, base: typeof fetch = fetch): typeof fetch {
  const secretNames = new Set([...secretHeaders].map((n) => n.toLowerCase()));
  let exchanges = 0;
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const exchange = ++exchanges;
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const request: HttpDetails = { exchange, method, url, headers: loggedHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined), secretNames) };
    const body = await requestBytes(input, init);
    // A body the log cannot read still goes to the server; the log says so
    // in place of bytes it does not have.
    if (body instanceof Uint8Array) emit({ direction: 'out', kind: 'wire', bytes: body, http: request });
    else appEvent(emit, { event: 'request-body-not-recorded', bodyType: body.unrecorded, ...request });

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

/**
 * Which handshake to use. `auto` probes with `server/discover` and falls back
 * to `initialize` per the spec's probe order; `legacy` sends `initialize`
 * straight away, for a server whose era is pinned as legacy (D20).
 */
export type EraPreference = 'auto' | 'legacy';

/** How a stdio server process ended. */
export interface ProcessExit {
  code: number | null;
  signal: string | null;
  /** Milliseconds from spawn to exit. */
  lifetimeMs: number;
}

/** Why a connection could not be made, leading with what the process or server did (plan, phase 04). */
export type ConnectFailure =
  /** The process never ran: the command was not found or could not be executed. */
  | { kind: 'not-started'; errorCode?: string }
  /** The process started, then exited before the connection was made. */
  | { kind: 'exited'; exit: ProcessExit; lastRequest?: string; diedOnProbe: boolean }
  /** The server answered that it does not speak the revision asked for, and listed what it does. */
  | { kind: 'unsupported-version'; supported: string[] }
  /** An HTTP server answered with an error status. */
  | { kind: 'http-status'; status: number }
  /** The server answered, and the answer was not a usable handshake. */
  | { kind: 'protocol'; code?: string | number };

/**
 * A connection that could not be made. `message` is the protocol-level error;
 * `failure` says what the process or server did, which is what a user needs
 * first. `stderr` is the tail of the server's stderr, stdio only.
 */
export class ConnectError extends Error {
  constructor(message: string, readonly failure: ConnectFailure, readonly stderr = '', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConnectError';
  }
}

/** What a finished connection reports when it ends for any reason, including close(). */
export interface CloseInfo {
  /** stdio only: how the process ended, when it has. */
  exit?: ProcessExit;
}

const errorCode = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The versions a -32022 answer lists, or undefined when the error is not one. */
function unsupportedVersions(e: unknown): string[] | undefined {
  if (errorCode(e) !== -32022) return undefined;
  const err = e as { supported?: unknown; data?: { supported?: unknown } };
  const supported = err.supported ?? err.data?.supported;
  return Array.isArray(supported) ? supported.filter((v): v is string => typeof v === 'string') : [];
}

/** An `app` unit: an event the app records beside the wire traffic (D34). */
function appEvent(emit: UnitListener | undefined, event: Record<string, unknown>): void {
  emit?.({ direction: 'local', kind: 'app', bytes: Buffer.from(JSON.stringify(event), 'utf8') });
}

export async function connectHttp(opts: HttpConnectOptions): Promise<Connection> {
  const mod: any = await import('@modelcontextprotocol/client');
  const Transport = opts.kind === 'sse' ? mod.SSEClientTransport : mod.StreamableHTTPClientTransport;
  const info = { name: opts.clientName ?? 'mcp-explorer', version: opts.clientVersion ?? '0.0.0' };
  // No sibling-probe problem here: only the stdio transport spawns anything.
  // The taps are still required, or negotiation traffic bypasses P1's logger.
  const emit = unitSink(opts.onUnit, opts.onUnitError);
  const secretHeaders = opts.secretHeaders ?? {};
  // One logging fetch for every attempt, so exchange numbers keep counting.
  const fetchOption = emit ? { fetch: loggingFetch(emit, Object.keys(secretHeaders)) } : {};

  const attempt = async (negotiate: boolean) => {
    const client = makeClient(mod.Client, info, { negotiate, probeTimeoutMs: opts.probeTimeoutMs });
    const transport = new Transport(new URL(opts.url), { requestInit: { headers: { ...opts.headers, ...secretHeaders } }, ...fetchOption });
    try {
      await client.connect(tap(transport, opts.onFrame, opts.onFrameError));
      return client;
    } catch (e) {
      // An SSE transport holds its event stream open; a failed attempt must not leak it.
      await client.close().catch(() => undefined);
      throw e;
    }
  };

  let client: any;
  try {
    if (opts.era === 'legacy') {
      try {
        client = await attempt(false);
      } catch (e) {
        // D20: re-probe on -32022. Nothing is spawned over HTTP, so this is
        // automatic, unlike stdio (clarified 2026-09-24).
        const supported = unsupportedVersions(e);
        if (supported === undefined) throw e;
        appEvent(emit, { event: 're-probe', reason: 'unsupported-version', supported });
        client = await attempt(true);
      }
    } else {
      try {
        client = await attempt(true);
      } catch (e) {
        // The spec's probe order reads anything but a clean modern answer as
        // legacy. The SDK does that itself for a JSON-RPC error; over HTTP it
        // rejects instead on a timeout or a failed probe (a dropped
        // connection, a 5xx), so the fallback is done here. Automatic: nothing
        // is spawned (D20).
        const code = errorCode(e);
        if (code !== 'REQUEST_TIMEOUT' && code !== 'ERA_NEGOTIATION_FAILED') throw e;
        appEvent(emit, { event: 'legacy-fallback', reason: messageOf(e) });
        client = await attempt(false);
      }
    }
  } catch (e) {
    throw classifyHttp(e);
  }
  return describe(client);
}

function classifyHttp(e: unknown): ConnectError {
  if (e instanceof ConnectError) return e;
  const supported = unsupportedVersions(e);
  if (supported !== undefined) return new ConnectError(messageOf(e), { kind: 'unsupported-version', supported }, '', { cause: e });
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return new ConnectError(messageOf(e), { kind: 'http-status', status }, '', { cause: e });
  const code = errorCode(e);
  return new ConnectError(messageOf(e), { kind: 'protocol', ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}) }, '', { cause: e });
}

/** What one spawned process did, watched from the transport that owns it. */
interface ProcessWatch {
  pid?: number;
  spawnedAt?: number;
  exit?: ProcessExit;
  spawnError?: { code?: string; message: string };
  /** The last line written to the server, kept to name the request it died on. */
  lastLine?: string;
}

/** The method of the last request sent, read from its line only when a failure needs it. */
function lastMethod(watch: ProcessWatch): string | undefined {
  try {
    const m = JSON.parse(watch.lastLine ?? '');
    return typeof m?.method === 'string' ? m.method : undefined;
  } catch {
    return undefined;
  }
}

export async function connectStdio(opts: ConnectOptions): Promise<Connection> {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const Base = StdioClientTransport as unknown as new (o: unknown) => any;
  const emit = unitSink(opts.onUnit, opts.onUnitError);
  const watch: ProcessWatch = {};

  // The stdio half of the P1 seam (D34). Never define `_dispose` here: an own
  // `_dispose` on this prototype is exactly what makes the SDK spawn a sibling
  // (see the comment at the top of this file); test/wire-tap.test.mjs catches it.
  class SeamStdioTransport extends Base {
    constructor(o: unknown) {
      super(o);
      // Every line from the server passes through here as bytes before the
      // SDK parses it, including the lines it would drop: a banner, an HTML
      // page, a line that is not JSON at all.
      if (emit) this._readBuffer = new LoggingReadBuffer(this._readBuffer, emit, (o as { maxBufferSize?: number }).maxBufferSize ?? STDIO_MAX_LINE_BYTES);
    }

    async start(): Promise<void> {
      try {
        await super.start();
      } catch (e) {
        // POSIX: a command that cannot be executed fails the spawn itself.
        watch.spawnError = { code: errorCode(e) as string | undefined, message: messageOf(e) };
        appEvent(emit, { event: 'not-started', command: opts.command, code: watch.spawnError.code, message: watch.spawnError.message });
        throw e;
      }
      const child = this._process;
      watch.pid = child?.pid;
      watch.spawnedAt = Date.now();
      appEvent(emit, { event: 'spawned', pid: watch.pid, command: opts.command, args: opts.args ?? [] });
      child?.on('exit', (code: number | null, signal: string | null) => {
        watch.exit = { code, signal, lifetimeMs: Date.now() - (watch.spawnedAt ?? Date.now()) };
        appEvent(emit, { event: 'exited', pid: watch.pid, ...watch.exit });
      });
      // Windows: the SDK spawns through cross-spawn, which runs an unresolved
      // command through cmd.exe, so the spawn succeeds and "not found" arrives
      // later as an ENOENT error in place of the exit.
      child?.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') return;
        watch.spawnError = { code: e.code, message: e.message };
        appEvent(emit, { event: 'not-started', command: opts.command, code: e.code, message: e.message });
      });
      // A server that exits on its own never makes the SDK clear its buffer,
      // so a last line without a newline is recorded when stdout ends.
      if (emit) child?.stdout?.on('end', () => (this._readBuffer as LoggingReadBuffer).flushTail());
      // The SDK writes each outgoing message with one stdin.write of its
      // serialized line; recording at that call records exactly those bytes.
      const stdin = child?.stdin;
      if (!stdin) return;
      const write = stdin.write.bind(stdin);
      stdin.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        watch.lastLine = asBuffer(bytes).toString('utf8');
        emit?.({ direction: 'out', kind: 'wire', bytes });
        return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
      };
    }
  }

  const transportOptions = {
    command: opts.command,
    args: opts.args ?? [],
    env: opts.env ?? (process.env as Record<string, string>),
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    stderr: 'pipe' as const,
  };

  // Piping stderr obliges us to READ it. An unread pipe fills at roughly 64KB
  // and the child then blocks in write() forever -- the capture hangs with no
  // error, which is worse than any diagnostic this buffer provides.
  // Read as bytes: a line the log records must be the bytes the server wrote,
  // and decoding first would replace invalid UTF-8. The text view decodes with
  // a streaming decoder, so a character split across chunks survives.
  const stderrTail = { text: '' };
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

  const era = opts.era ?? 'auto';
  const client = makeClient(Client, { name: opts.clientName ?? 'mcp-explorer', version: opts.clientVersion ?? '0.0.0' }, { negotiate: era === 'auto', probeTimeoutMs: opts.probeTimeoutMs });

  try {
    await client.connect(tap(inner, opts.onFrame, opts.onFrameError));
  } catch (e) {
    const failure = classifyStdio(e, watch);
    // A server that answered is still running, and must be ended here. The
    // SDK's close() signals only the process it spawned, which orphans what a
    // shell root started (D36), so a caller that can end a whole tree says so.
    if (failure.kind !== 'not-started' && failure.kind !== 'exited') {
      if (opts.terminate && watch.pid !== undefined) {
        await opts.terminate(watch.pid).catch((err: unknown) => {
          process.emitWarning(`could not end process tree ${watch.pid} after a failed connect: ${messageOf(err)}`, 'MCPExplorerProcessWarning');
        });
      }
      await inner.close().catch(() => undefined);
    }
    // D20 (revised 2026-09-24): no second spawn here. A server that died on
    // the probe, or answered -32022 to a pinned legacy initialize, is
    // reported; starting it again is the user's decision.
    throw new ConnectError(messageOf(e), failure, stderrTail.text, { cause: e });
  }

  client.onclose = () => opts.onClose?.({ exit: watch.exit });
  return { ...(await describe(client)), pid: watch.pid, startedAt: watch.spawnedAt };
}

function classifyStdio(e: unknown, watch: ProcessWatch): ConnectFailure {
  if (watch.spawnError) return { kind: 'not-started', errorCode: watch.spawnError.code };
  if (watch.exit) {
    const lastRequest = lastMethod(watch);
    return { kind: 'exited', exit: watch.exit, ...(lastRequest ? { lastRequest } : {}), diedOnProbe: lastRequest === 'server/discover' };
  }
  const supported = unsupportedVersions(e);
  if (supported !== undefined) return { kind: 'unsupported-version', supported };
  const code = errorCode(e);
  return { kind: 'protocol', ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}) };
}
