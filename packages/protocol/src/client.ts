// The SDK adapter: connect to a server with the P1 seam intact and the era
// resolved, then expose it as a SurfaceSource the capture layer can walk.
//
// Everything protocol-shaped lives here so the rest of the package stays
// testable without spawning anything.
import type { Era } from './model.js';
import { eraOf } from './model.js';
import type { Page, SurfaceSource } from './capture.js';
import { StringDecoder } from 'node:string_decoder';
import { LineSplitter, SseEventSplitter, sseEventData, type HttpDetails, type UnitListener, type WireUnit } from './wire.js';
import { encodeHeaderValue } from './mcp-headers.js';

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
  /** A server's notice that a list changed. Nothing is re-listed. */
  onListChanged?: ListChangedListener;
  /** Legacy era: the server's own requests (sampling, elicitation, roots, any other), for a person to answer. */
  onServerRequest?: ServerRequestListener;
  /** Every notification the server sends, as the tap saw it, whatever the SDK does with it. */
  onNotification?: NotificationListener;
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
  /** How the session travels: Mcp-Param-* headers exist on Streamable HTTP only. */
  transport: 'stdio' | HttpTransportKind;
  source: SurfaceSource;
  /**
   * Sends one tools/call, prompts/get or resources/read as the user asked, and
   * reports what came back exactly as the server sent it. Never retries (P2).
   */
  call(request: CallRequest): Promise<CallOutcome>;
  /** Sends one utility request as the user asked: ping, a completion, a subscription. Never retried. */
  request(request: UtilityRequest): Promise<UtilityOutcome>;
  /** The log level the user set this session; undefined until one is set. */
  readonly logLevel: LogLevel | undefined;
  /**
   * Sets the log level (phase 10 decision 5). Legacy: sends logging/setLevel
   * and resolves with its outcome. Modern: holds the level for every later
   * request's _meta, sends nothing, and resolves undefined.
   */
  setLogLevel(level: LogLevel | undefined): Promise<UtilityOutcome | undefined>;
  /**
   * Modern era: opens one subscriptions/listen stream with this filter, as the
   * user asked. Sent through request() with no timeout, never the SDK's
   * listen(), whose 60 s acknowledgement timeout cancels on its own (P2). The
   * acknowledgement arrives as a notification. On legacy it sends nothing and
   * ends at once as failed.
   */
  listen(filter: SubscriptionFilter): ListenHandle;
  /**
   * One request about a task, as the user asked. Legacy: through request().
   * Modern: SDK 2.0.0 refuses the task methods locally, so this module frames
   * the request itself with the SDK's own _meta envelope and sends it on the
   * tapped transport (P1 holds), pairing the reply by id.
   */
  task(request: TaskRequest): Promise<CallOutcome>;
  /** stdio only: the process the app spawned, the root of its tree (D36). */
  pid?: number;
  /** stdio only: when that process was seen to spawn, milliseconds since the epoch. */
  startedAt?: number;
  close(): Promise<void>;
}

// D21: declaring these is what permits a server to ask for them at all. A
// server MUST NOT send an input request for a capability the client did not
// declare, so this list decides what the app can be asked to do (phase 08
// decision 3). A bare `elicitation: {}` means form only, and the SDK then
// refuses a URL-mode request with -32602 on its own. `sampling.tools`: the
// human can write tool_use content. Never `elicitation.form.applyDefaults`,
// which makes the SDK fill schema defaults into the human's answer (P2), and
// no `roots.listChanged`: the app keeps no roots to change.
export const CLIENT_CAPABILITIES = { sampling: { tools: {} }, elicitation: { form: {}, url: {} }, roots: {} };

/** A request the server sent the client (legacy era), exactly as it arrived. */
export interface ServerRequest {
  id: string | number;
  method: string;
  /** The params as sent, _meta included; nothing is validated first. */
  params: unknown;
  /** Aborts when the server cancels the request; nothing is sent back after that. */
  signal: AbortSignal;
}

/** What the human sends back: a result, or a JSON-RPC error. */
export type ServerAnswer =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string; data?: unknown } };

/**
 * Answers a server's request. Resolves only when a person has answered: the
 * SDK has no timeout on it, and nothing here answers on anyone's behalf (P2).
 */
export type ServerRequestListener = (request: ServerRequest) => Promise<ServerAnswer>;

/**
 * Every request a server sends, whatever its method, goes to the listener
 * raw. Not setRequestHandler: the SDK wraps a registered sampling or
 * elicitation handler in validation that answers -32602 to the server before
 * the handler runs, and checks the answer too (phase 08 decision 1). Only a
 * method with its own handler bypasses this; the SDK registers `ping`, and
 * its automatic empty reply stays (decision 2).
 *
 * With no listener a request waits, unanswered, until the session ends. The
 * SDK's alternative is -32601, an answer nobody gave.
 */
function answerServerRequests(client: any, listener: ServerRequestListener | undefined): void {
  client.fallbackRequestHandler = async (request: { id: string | number; method: string; params?: unknown }, ctx: { mcpReq: { signal: AbortSignal } }) => {
    if (!listener) return new Promise<never>(() => undefined);
    const answer = await listener({ id: request.id, method: request.method, params: request.params, signal: ctx.mcpReq.signal });
    if ('error' in answer) {
      // The SDK sends a thrown value's code, message and data as the error.
      throw Object.assign(new Error(answer.error.message), { code: answer.error.code, ...(answer.error.data === undefined ? {} : { data: answer.error.data }) });
    }
    return answer.result;
  };
}

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
  opts: { negotiate: boolean; probeTimeoutMs?: number; onListChanged?: ListChangedListener; onServerRequest?: ServerRequestListener },
): any {
  // Never the SDK's `listChanged` option: its autoRefresh defaults to true and
  // re-lists on every notice, and on the modern era it also opens a
  // subscription at connect. Both are calls the user did not make (P2).
  const client = new Client(info, {
    capabilities: CLIENT_CAPABILITIES,
    // P2: by default the SDK answers input_required through registered
    // handlers and retries on its own, and retries a requestState-only result
    // after 250 ms with no human at all. Off, such a result is refused rather
    // than retried; call() asks for it raw with allowInputRequired.
    inputRequired: { autoFulfill: false },
    ...(opts.negotiate
      ? { versionNegotiation: { mode: 'auto', probe: { timeoutMs: opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS } } }
      : {}),
  });
  answerServerRequests(client, opts.onServerRequest);
  const onListChanged = opts.onListChanged;
  if (onListChanged) {
    // Registering sends nothing; a notice is only reported. On 2026-07-28 a
    // server sends these only on a subscriptions/listen stream, which the app
    // does not open (phase 06 decision 7), so in practice this is legacy only.
    for (const [method, list] of LIST_CHANGED) {
      client.setNotificationHandler(method, () => onListChanged(list));
    }
  }
  return client;
}

/** A notification from the server: method and params as sent. */
export interface ServerNotification {
  method: string;
  params: unknown;
}
/**
 * Told of every notification the server sends. Read from the tap, not the
 * SDK's dispatch: on the modern era the SDK drops some it does not model
 * (notifications/tasks/status, notifications/elicitation/complete), and an
 * explorer shows them anyway. Only reports; nothing is sent back.
 */
export type NotificationListener = (notification: ServerNotification) => void;

export type ChangedList = 'tools' | 'prompts' | 'resources';
/** Told which list a server says changed. The app never re-lists on its own (P2). */
export type ListChangedListener = (list: ChangedList) => void;

const LIST_CHANGED: [string, ChangedList][] = [
  ['notifications/tools/list_changed', 'tools'],
  ['notifications/prompts/list_changed', 'prompts'],
  ['notifications/resources/list_changed', 'resources'],
];

function tap(inner: any, listener: FrameListener | undefined, onFrameError: FrameErrorListener = warnFrameError, calls?: CallTracker, onNotification?: NotificationListener): any {
  if (!listener && !calls && !onNotification) return inner;
  // A listener that throws must not cost the protocol the frame. Called before
  // the SDK's handler, an exception here made the transport drop the message
  // (the request then hung) or reject the send; it is reported instead.
  const onFrame: FrameListener = (direction, frame) => {
    calls?.see(direction, frame);
    if (onNotification && direction === 'in') reportNotification(frame, onNotification);
    if (!listener) return;
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
      if (p === 'onclose' && calls) {
        // The session is over: replies to requests framed here will not come.
        return Reflect.set(t, p, (...a: unknown[]) => { calls.end(); return (v as ((...x: unknown[]) => unknown) | undefined)?.(...a); });
      }
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

/** A listener that throws must not cost the connection the frame; it is warned about instead. */
function reportNotification(frame: unknown, listener: NotificationListener): void {
  const m = frame as { id?: unknown; method?: unknown; params?: unknown } | null;
  if (!m || typeof m !== 'object' || typeof m.method !== 'string' || (m.id !== undefined && m.id !== null)) return;
  try {
    listener({ method: m.method, params: m.params });
  } catch (error) {
    process.emitWarning('a notification listener failed: ' + messageOf(error), 'MCPExplorerFrameLogWarning');
  }
}

/**
 * A list endpoint the server does not advertise is absent, not an error.
 *
 * One page per call, read raw: the page is the response the tap saw, and
 * captureSurface walks the cursors. Not the SDK's listTools() and friends,
 * for three reasons, each measured:
 *
 * 1. They validate the whole reply, so ONE malformed entry (a string
 *    readOnlyHint, an inputSchema that is not an object) failed the entire
 *    list and the capture showed no tools at all (phase 07; pinned by
 *    test/capture-raw.test.mjs). The malformed entry is what an explorer is
 *    for.
 * 2. listTools() drops a tool whose `x-mcp-header` declarations it finds
 *    invalid, with only a console warning.
 * 3. They answer from the SDK's response cache within the server's `ttlMs`
 *    (SEP-2549) unless told to bypass it, and a capture must reflect the
 *    server now. request() never consults that cache.
 */
function lister(
  session: Session,
  method: 'tools/list' | 'prompts/list' | 'resources/list' | 'resources/templates/list',
  field: 'tools' | 'prompts' | 'resources' | 'resourceTemplates',
  supported: boolean,
): ((cursor?: string) => Promise<Page<Record<string, unknown>>>) | undefined {
  if (!supported) return undefined;
  return async (cursor?: string) => {
    // No timeout: the SDK's 60 s default sends notifications/cancelled, a
    // request the user did not make (P2). A list that never answers holds the
    // capture until the user disconnects.
    const r = await rawRequest(session, method, cursor === undefined ? {} : { cursor }, { timeout: NO_TIMEOUT_MS });
    if (!r.response) throw r.failure;
    if ('error' in r.response) {
      const e = (r.response.error ?? {}) as { code?: unknown; message?: unknown };
      throw new Error(`MCP error ${String(e.code)}: ${String(e.message)}`);
    }
    const result = (r.response.result ?? {}) as Record<string, unknown>;
    if (result.resultType === 'input_required') {
      throw new Error(`the server answered ${method} with input_required, which the specification allows only on tools/call, prompts/get and resources/read`);
    }
    const items = result[field];
    if (!Array.isArray(items)) throw new Error(`the ${method} result has no ${field} array`);
    return { items: items as Record<string, unknown>[], nextCursor: typeof result.nextCursor === 'string' ? result.nextCursor : undefined };
  };
}

export type CallKind = 'tool' | 'prompt' | 'resource';

export interface CallRequest {
  kind: CallKind;
  /** The tool or prompt name, or the resource URI. */
  target: string;
  /** A tool's or prompt's arguments. Sent as given; nothing is filled in. */
  args?: Record<string, unknown>;
  /** Aborting sends the cancellation the era uses; the server may still finish. */
  signal?: AbortSignal;
  onProgress?: (progress: CallProgress) => void;
  /** Phase 08: a retry's answers, keyed as the server asked. */
  inputResponses?: Record<string, unknown>;
  /** Phase 08: echoed byte-exact, and only when the server sent one (D16). */
  requestState?: string;
  /**
   * Legacy (2025-11-25): run the tool call as a task, `params.task`. On the
   * modern era the server decides per request and there is no such field.
   */
  task?: { ttl?: number };
  /** Extra HTTP request headers for this request, such as Mcp-Param-* (phase 10 decision 11). */
  headers?: Record<string, string>;
}

export interface CallProgress {
  progress: number;
  total?: number;
  message?: string;
}

/**
 * What a call came to. A result or error is the JSON-RPC response as it
 * arrived, before the SDK decoded it: `resultType` intact, unknown content
 * types kept. `sdkRejected` is the SDK's objection to a result it would not
 * return, which the app reports and does not act on.
 */
export type CallOutcome =
  | { kind: 'result'; requestId: string | number; result: Record<string, unknown>; sdkRejected?: string }
  | { kind: 'error'; requestId: string | number; error: { code?: unknown; message?: unknown; data?: unknown } }
  /** The user cancelled before a response came. */
  | { kind: 'cancelled'; requestId: string | number }
  /** No response: the session ended, or the request could not be sent. */
  | { kind: 'failed'; requestId?: string | number; message: string };

export const CALL_METHOD: Record<CallKind, string> = { tool: 'tools/call', prompt: 'prompts/get', resource: 'resources/read' };

/** The syslog levels MCP logging uses, least severe first (every revision). */
export const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LOG_LEVEL_META_KEY = 'io.modelcontextprotocol/logLevel';

/**
 * A protocol request the user asked for that is not a call: each one is sent
 * once, on a click, with no timeout (P2; phase 10).
 */
export type UtilityMethod = 'ping' | 'logging/setLevel' | 'completion/complete' | 'resources/subscribe' | 'resources/unsubscribe';

export interface UtilityRequest {
  method: UtilityMethod;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * What a modern subscriptions/listen stream asks for (2026-07-28
 * SubscriptionFilter). Open-ended: an extension's field, such as the tasks
 * extension's taskIds, goes through as given.
 */
export interface SubscriptionFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
  [extension: string]: unknown;
}

/** How a listen stream ended. */
export type ListenEnd =
  /** The user closed it: the era's cancellation was sent. */
  | { kind: 'closed' }
  /** The server ended it gracefully with the listen result. */
  | { kind: 'result'; result: Record<string, unknown> }
  /** The server answered the listen with an error. */
  | { kind: 'error'; error: { code?: unknown; message?: unknown; data?: unknown } }
  /** The server cancelled it (notifications/cancelled naming the listen). */
  | { kind: 'cancelled-by-server'; reason?: unknown }
  /** No response: the session ended, or the request could not be sent. */
  | { kind: 'failed'; message: string };

/** An open modern listen stream (phase 10 decision 7). */
export interface ListenHandle {
  /** The listen request's id: every notification on the stream carries it as its subscriptionId. Absent when nothing was sent. */
  readonly requestId?: string | number;
  /** Settles when the stream ends, for any reason. */
  readonly ended: Promise<ListenEnd>;
  /** Ends the stream as the user asked: the SDK sends the era's cancellation. */
  close(): void;
}

export const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';

/** The tasks extension's identifier (2026-07-28; SEP-2663). */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

/**
 * A request about a task, sent once on the user's word; nothing polls (phase
 * 10 decision 2). Legacy (2025-11-25 core): get, result, cancel, list. Modern
 * (the tasks extension): get, update, cancel.
 */
export type TaskMethod = 'tasks/get' | 'tasks/result' | 'tasks/cancel' | 'tasks/list' | 'tasks/update';

export interface TaskRequest {
  method: TaskMethod;
  params: Record<string, unknown>;
}

const TASK_METHODS_BY_ERA: Record<Era, ReadonlySet<TaskMethod>> = {
  legacy: new Set<TaskMethod>(['tasks/get', 'tasks/result', 'tasks/cancel', 'tasks/list']),
  modern: new Set<TaskMethod>(['tasks/get', 'tasks/update', 'tasks/cancel']),
};

/** Why this task request cannot go to a server on this era, or undefined when it can. */
export function taskRefusal(method: TaskMethod, era: Era, revision: string): string | undefined {
  return TASK_METHODS_BY_ERA[era].has(method) ? undefined : method + ' does not exist on ' + revision;
}

/** A utility request's outcome, and how long it took from send to response. */
export type UtilityOutcome = CallOutcome & { elapsedMs: number };

/**
 * The methods 2026-07-28 removed: ping, logging/setLevel and
 * resources/(un)subscribe (its changelog items 4 and 5). Each would otherwise
 * fail inside the SDK with no frame sent.
 */
const ABSENT_ON_MODERN: ReadonlySet<UtilityMethod> = new Set<UtilityMethod>(['ping', 'logging/setLevel', 'resources/subscribe', 'resources/unsubscribe']);

/** Why this request cannot go to a server on this era, or undefined when it can. */
export function utilityRefusal(method: UtilityMethod, era: Era, revision: string): string | undefined {
  if (era === 'modern' && ABSENT_ON_MODERN.has(method)) return method + ' does not exist on ' + revision;
  return undefined;
}

/**
 * setTimeout's ceiling, about 24.8 days: the SDK has no "never", and a larger
 * value fires at once. Phase 07 decision 2: a call does not time out, because
 * a timeout sends a cancellation the user did not ask for (P2).
 */
const NO_TIMEOUT_MS = 2 ** 31 - 1;

/** Accepts any result, so the SDK's result schema never stands between the server and the app. */
const PASS_THROUGH = {
  '~standard': { version: 1, vendor: 'mcp-explorer', validate: (value: unknown) => ({ value }) },
};

const idKey = (id: unknown) => JSON.stringify(id);

/**
 * Pairs a call with its request id and its response as the tap saw them. The
 * SDK assigns the id and hands the frame to the transport synchronously inside
 * request(), so the frame passes here before request() returns; an armed slot
 * takes the id of the next outgoing request with its method.
 */
class CallTracker {
  private armed: { method: string; id?: string | number } | undefined;
  private readonly responses = new Map<string, Record<string, unknown>>();
  private readonly watched = new Set<string>();
  private readonly cancels = new Map<string, (reason: unknown) => void>();
  /** Requests whose event stream ended without their response (phase 10 decision 13). */
  private readonly abandons = new Map<string, (message: string) => void>();
  /** Replies this module is waiting on for requests it framed itself. */
  private readonly waiters = new Map<string, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();

  see(direction: FrameDirection, frame: unknown): void {
    const m = frame as { id?: unknown; method?: unknown; params?: { requestId?: unknown; reason?: unknown } } | null;
    if (direction === 'in' && m && typeof m === 'object' && m.method === 'notifications/cancelled' && m.params) {
      this.cancels.get(idKey(m.params.requestId))?.(m.params.reason);
    }
    if (!m || typeof m !== 'object' || m.id === undefined || m.id === null) return;
    if (direction === 'out' && this.armed && m.method === this.armed.method && this.armed.id === undefined) {
      this.armed.id = m.id as string | number;
      this.watched.add(idKey(m.id));
    } else if (direction === 'in' && m.method === undefined && this.waiters.has(idKey(m.id))) {
      const waiter = this.waiters.get(idKey(m.id))!;
      this.waiters.delete(idKey(m.id));
      waiter.resolve(m as Record<string, unknown>);
    } else if (direction === 'in' && m.method === undefined && this.watched.has(idKey(m.id))) {
      this.responses.set(idKey(m.id), m as Record<string, unknown>);
    }
  }

  /**
   * Runs send() with the slot armed and returns the id it produced. No id means
   * no frame went out: the SDK refused the request first (not connected).
   */
  send<T>(method: string, send: () => T): { id?: string | number; sent: T } {
    if (this.armed) throw new Error('a call is already being sent');
    this.armed = { method };
    try {
      const sent = send();
      return { ...(this.armed.id === undefined ? {} : { id: this.armed.id }), sent };
    } finally {
      this.armed = undefined;
    }
  }

  /** Resolves with the reply to a request this module framed itself; rejects when the session ends first. */
  expect(id: string | number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => this.waiters.set(idKey(id), { resolve, reject }));
  }

  /** Resolves with why, if the request's response will never come because its stream ended first. */
  whenAbandoned(id: string | number): Promise<string> {
    return new Promise((resolve) => this.abandons.set(idKey(id), resolve));
  }

  /** The stream carrying this request's response ended without it: the request fails, and nothing is sent. */
  abandon(id: unknown, message: string): void {
    const key = idKey(id);
    const waiter = this.waiters.get(key);
    this.waiters.delete(key);
    waiter?.reject(new Error(message));
    this.abandons.get(key)?.(message);
    this.abandons.delete(key);
  }

  /** The session ended: every reply still awaited will never come. */
  end(): void {
    for (const w of this.waiters.values()) w.reject(new Error('the session ended before a response arrived'));
    this.waiters.clear();
  }

  /** Calls back when the server cancels the request we sent under this id. */
  watchCancel(id: string | number, onCancel: (reason: unknown) => void): void {
    this.cancels.set(idKey(id), onCancel);
  }

  unwatchCancel(id: string | number): void {
    this.cancels.delete(idKey(id));
  }

  /** Whether the response for this id has arrived. */
  has(id: string | number): boolean {
    return this.responses.has(idKey(id));
  }

  /** The response the tap saw for this id, if any; forgets the id either way. */
  take(id: string | number): Record<string, unknown> | undefined {
    const key = idKey(id);
    this.waiters.delete(key);
    this.abandons.delete(key);
    const response = this.responses.get(key);
    this.responses.delete(key);
    this.watched.delete(key);
    return response;
  }
}

/**
 * The params a call sends, before the SDK adds its `_meta`: the one place they
 * are built, so the confirm shows what call() will send (phase 07 decision 5).
 */
export function callParams(req: Pick<CallRequest, 'kind' | 'target' | 'args' | 'inputResponses' | 'requestState' | 'task'>): Record<string, unknown> {
  const params: Record<string, unknown> = req.kind === 'resource' ? { uri: req.target } : { name: req.target };
  if (req.kind !== 'resource' && req.args !== undefined) params.arguments = req.args;
  if (req.inputResponses !== undefined) params.inputResponses = req.inputResponses;
  if (req.requestState !== undefined) params.requestState = req.requestState;
  if (req.kind === 'tool' && req.task !== undefined) params.task = req.task;
  return params;
}

async function callOn(session: Session, req: CallRequest): Promise<CallOutcome> {
  const method = CALL_METHOD[req.kind];
  const params = callParams(req);
  const onProgress = req.onProgress;
  const options = {
    allowInputRequired: true,
    timeout: NO_TIMEOUT_MS,
    ...(req.signal ? { signal: req.signal } : {}),
    ...(req.headers ? { headers: req.headers } : {}),
    ...(onProgress ? {
      onprogress: (p: CallProgress) => onProgress({
        progress: p.progress,
        ...(p.total === undefined ? {} : { total: p.total }),
        ...(p.message === undefined ? {} : { message: p.message }),
      }),
    } : {}),
  };

  const r = await rawRequest(session, method, params, options);
  return outcomeOf(r);
}

/** What a raw request came to, as a call outcome. */
function outcomeOf(r: RawResponse): CallOutcome {
  if (r.requestId === undefined) return { kind: 'failed', message: messageOf(r.failure) };
  const requestId = r.requestId;
  // A response the SDK accepted before the abort is the outcome: the cancel
  // came too late to send anything (R07-4). One arriving after the abort the
  // SDK ignores, and so does this; the wire log still has it.
  const response = r.response;
  if (r.abortedFirst) return { kind: 'cancelled', requestId };
  if (response && 'error' in response) return { kind: 'error', requestId, error: (response.error ?? {}) as { code?: unknown; message?: unknown; data?: unknown } };
  if (response) {
    const result = (response.result && typeof response.result === 'object' ? response.result : {}) as Record<string, unknown>;
    return { kind: 'result', requestId, result, ...(r.sdkError === undefined ? {} : { sdkRejected: messageOf(r.sdkError) }) };
  }
  return { kind: 'failed', requestId, message: messageOf(r.failure) };
}

/**
 * One request through the SDK, answered by the response the tap saw for its
 * id: the server's message before the SDK decoded or validated it. The SDK
 * still does everything else a request needs (the id, `_meta`, progress,
 * cancellation). `failure` says why there is no response.
 */
interface RawResponse {
  requestId?: string | number; response?: Record<string, unknown>; sdkError?: unknown; failure: unknown;
  /** The request's signal aborted before its response arrived: the request was cancelled. */
  abortedFirst?: true;
}

async function rawRequest(session: Session, method: string, params: Record<string, unknown>, options: Record<string, unknown>): Promise<RawResponse> {
  const { client, calls } = session;
  // onSent is ours: told the id the moment the frame is out, before any reply.
  const { onSent, ...sdkOptions } = options as Record<string, unknown> & { onSent?: (id: string | number) => void };
  let sent: { id?: string | number; sent: Promise<unknown> };
  try {
    sent = calls.send(method, () => client.request({ method, params: withLogLevel(session, params) }, PASS_THROUGH, sdkOptions) as Promise<unknown>);
  } catch (e) {
    return { failure: e };
  }
  let abortedFirst = false;
  const signal = options.signal as AbortSignal | undefined;
  const id = sent.id;
  if (id !== undefined) onSent?.(id);
  const onAbort = () => { abortedFirst = id === undefined || !calls.has(id); };
  signal?.addEventListener('abort', onAbort, { once: true });
  let sdkError: unknown;
  // The SDK never settles a request whose event stream died without its
  // response; the logging fetch notices, and the request fails here instead.
  const abandoned = id === undefined ? new Promise<never>(() => undefined) : calls.whenAbandoned(id);
  try {
    const why = await Promise.race([sent.sent.then(() => undefined), abandoned]);
    if (typeof why === 'string') sdkError = new Error(why);
  } catch (e) {
    sdkError = e;
  }
  signal?.removeEventListener('abort', onAbort);
  if (sent.id === undefined) return { failure: sdkError ?? new Error(`the ${method} request never reached the transport`) };
  // The tap saw the response before the SDK's handler did, so by now it is
  // here if it came.
  const response = calls.take(sent.id);
  return {
    requestId: sent.id,
    ...(response ? { response } : {}),
    ...(sdkError === undefined ? {} : { sdkError }),
    ...(abortedFirst ? { abortedFirst: true as const } : {}),
    failure: sdkError ?? new Error('no response arrived'),
  };
}

/** One connected session: the SDK client, the tap's call tracker, and what the user set for it. */
interface Session {
  client: any;
  calls: CallTracker;
  era: Era;
  revision: string;
  /** Modern era: added to every request's _meta once the user sets it (phase 10 decision 5). */
  logLevel?: LogLevel;
  /** How many task requests this module framed itself (modern era), for their ids. */
  framed: number;
}

/**
 * Modern era: the user's log level rides on every request as
 * _meta["io.modelcontextprotocol/logLevel"]; without the key a server sends
 * no log messages for that request. The SDK never sets it, and a key given
 * here wins over its envelope. Legacy params go out untouched.
 */
function withLogLevel(session: Session, params: Record<string, unknown>): Record<string, unknown> {
  if (session.era !== 'modern' || session.logLevel === undefined) return params;
  const meta = (params._meta && typeof params._meta === 'object' ? params._meta : {}) as Record<string, unknown>;
  return { ...params, _meta: { ...meta, [LOG_LEVEL_META_KEY]: session.logLevel } };
}

async function utilityOn(session: Session, req: UtilityRequest): Promise<UtilityOutcome> {
  const refusal = utilityRefusal(req.method, session.era, session.revision);
  if (refusal) return { kind: 'failed', message: refusal, elapsedMs: 0 };
  const started = performance.now();
  const r = await rawRequest(session, req.method, req.params ?? {}, { timeout: NO_TIMEOUT_MS, ...(req.signal ? { signal: req.signal } : {}) });
  return { ...outcomeOf(r), elapsedMs: performance.now() - started };
}

async function setLogLevelOn(session: Session, level: LogLevel | undefined): Promise<UtilityOutcome | undefined> {
  if (session.era === 'modern') {
    session.logLevel = level;
    return undefined;
  }
  // Legacy has no way to unset a level: the protocol's lowest is still a level.
  if (level === undefined) return { kind: 'failed', message: 'a legacy server has no way to turn logging off once a level is set', elapsedMs: 0 };
  const outcome = await utilityOn(session, { method: 'logging/setLevel', params: { level } });
  if (outcome.kind === 'result') session.logLevel = level;
  return outcome;
}

function listenOn(session: Session, filter: SubscriptionFilter): ListenHandle {
  if (session.era !== 'modern') {
    return { ended: Promise.resolve({ kind: 'failed', message: 'subscriptions/listen does not exist on ' + session.revision }), close: () => undefined };
  }
  const abort = new AbortController();
  let requestId: string | number | undefined;
  let serverCancel: ((end: ListenEnd) => void) | undefined;
  const byServer = new Promise<ListenEnd>((resolve) => { serverCancel = resolve; });
  const onSent = (id: string | number) => {
    requestId = id;
    // The spec's cancellation page says a server ending a listen sends
    // notifications/cancelled naming it; its subscriptions page says the
    // listen result. Both are read. The SDK does not settle a request the
    // server cancelled, so this does, and nothing is sent back.
    session.calls.watchCancel(id, (reason) => serverCancel?.({ kind: 'cancelled-by-server', reason }));
  };
  const request = rawRequest(session, 'subscriptions/listen', { notifications: filter }, { timeout: NO_TIMEOUT_MS, signal: abort.signal, onSent }).then((r): ListenEnd => {
    if (r.abortedFirst) return { kind: 'closed' };
    const response = r.response;
    if (response && 'error' in response) return { kind: 'error', error: (response.error ?? {}) as { code?: unknown; message?: unknown; data?: unknown } };
    if (response) return { kind: 'result', result: (response.result && typeof response.result === 'object' ? response.result : {}) as Record<string, unknown> };
    return { kind: 'failed', message: messageOf(r.failure) };
  });
  const ended = Promise.race([request, byServer]).finally(() => { if (requestId !== undefined) session.calls.unwatchCancel(requestId); });
  return {
    get requestId() { return requestId; },
    ended,
    close: () => abort.abort(),
  };
}

async function taskOn(session: Session, req: TaskRequest): Promise<CallOutcome> {
  const refusal = taskRefusal(req.method, session.era, session.revision);
  if (refusal) return { kind: 'failed', message: refusal };
  if (session.era === 'legacy') return outcomeOf(await rawRequest(session, req.method, req.params, { timeout: NO_TIMEOUT_MS }));
  const client = session.client;
  if (typeof client._envelopeOutbound !== 'function' || !client.transport) {
    return { kind: 'failed', message: 'this SDK offers no way to frame a modern task request' };
  }
  // A string id: the SDK's own are numbers, so the two can never collide, and
  // the SDK, finding no handler for the reply, reports it and does nothing else.
  const id = 'mcpx-task-' + String(++session.framed);
  const message = client._envelopeOutbound({ jsonrpc: '2.0', id, method: req.method, params: withLogLevel(session, req.params) });
  const response = session.calls.expect(id);
  try {
    await client.transport.send(message);
  } catch (e) {
    session.calls.take(id);
    return { kind: 'failed', requestId: id, message: messageOf(e) };
  }
  try {
    const r = await response;
    if ('error' in r) return { kind: 'error', requestId: id, error: (r.error ?? {}) as { code?: unknown; message?: unknown; data?: unknown } };
    return { kind: 'result', requestId: id, result: (r.result && typeof r.result === 'object' ? r.result : {}) as Record<string, unknown> };
  } catch (e) {
    return { kind: 'failed', requestId: id, message: messageOf(e) };
  }
}

/** Everything after the transport is connected is identical across transports. */
async function describe(client: any, calls: CallTracker, transport: 'stdio' | HttpTransportKind): Promise<Connection> {
  const revision: string = client.getNegotiatedProtocolVersion?.() ?? '2025-06-18';
  const session: Session = { client, calls, era: eraOf(revision), revision, framed: 0 };
  // The tasks extension is declared on the modern era only: a legacy server
  // has no extensions field to read it in. The SDK reads its capabilities
  // afresh for every request's _meta envelope, and allows no registration
  // after connect, so they are set in place: an SDK internal, pinned by
  // test/phase10-tasks.test.mjs.
  if (session.era === 'modern' && client._capabilities && typeof client._capabilities === 'object') {
    client._capabilities = { ...client._capabilities, extensions: { ...(client._capabilities.extensions ?? {}), [TASKS_EXTENSION]: {} } };
  }
  const capabilities = client.getServerCapabilities?.() ?? {};
  const caps = capabilities as Record<string, unknown>;

  const source: SurfaceSource = {
    revision,
    era: eraOf(revision),
    serverInfo: client.getServerVersion?.(),
    instructions: client.getInstructions?.(),
    capabilities,
    listTools: lister(session, 'tools/list', 'tools', caps.tools !== undefined),
    listPrompts: lister(session, 'prompts/list', 'prompts', caps.prompts !== undefined),
    listResources: lister(session, 'resources/list', 'resources', caps.resources !== undefined),
    listResourceTemplates: lister(session, 'resources/templates/list', 'resourceTemplates', caps.resources !== undefined),
  };
  return {
    era: source.era, revision, source, transport,
    call: (req) => callOn(session, req),
    request: (req) => utilityOn(session, req),
    get logLevel() { return session.logLevel; },
    setLogLevel: (level) => setLogLevelOn(session, level),
    listen: (filter) => listenOn(session, filter),
    task: (req) => taskOn(session, req),
    close: () => client.close(),
  };
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
  /** A server's notice that a list changed. Nothing is re-listed. */
  onListChanged?: ListChangedListener;
  /** Legacy era: the server's own requests, for a person to answer. */
  onServerRequest?: ServerRequestListener;
  /** Every notification the server sends, as the tap saw it. */
  onNotification?: NotificationListener;
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
export function loggingFetch(emit: UnitListener, secretHeaders: Iterable<string>, base: typeof fetch = fetch, onOrphaned?: (ids: unknown[], message: string) => void): typeof fetch {
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

    // On the modern era a cancelled call over Streamable HTTP is an aborted
    // request with no notifications/cancelled (cancellation.mdx), so the abort
    // is recorded as an event of its own (P1). The SDK's signal also carries
    // the transport's own, which aborts on close, so the listener lives only
    // until the response is read whole: after that an abort ends nothing (R07-2).
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const onAbort = () => appEvent(emit, { event: 'request-aborted', exchange, method, url });
    const done = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    let response: Response;
    try {
      response = await base(input, init);
    } catch (e) {
      done();
      throw e;
    }
    const http: HttpDetails = { exchange, status: response.status, statusText: response.statusText, headers: loggedHeaders(response.headers, secretNames) };
    const rebuilt = (body: BodyInit | null) => new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });

    if (!response.body) {
      done();
      emit({ direction: 'in', kind: 'wire', bytes: new Uint8Array(0), http });
      return response;
    }
    if (!/^\s*text\/event-stream\b/i.test(response.headers.get('content-type') ?? '')) {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } finally {
        done();
      }
      emit({ direction: 'in', kind: 'wire', bytes, http });
      return rebuilt(bytes);
    }
    const events = new SseEventSplitter();
    // The requests this POST carried, until an event answers each (decision 13).
    const unanswered = requestIds(body);
    const event = (bytes: Uint8Array) => {
      emit({ direction: 'in', kind: 'wire', bytes, http: { ...http, framing: 'sse-event' } });
      if (unanswered.size > 0) for (const id of responseIds(bytes)) unanswered.delete(id);
    };
    // The stream ended with requests unanswered, and not because the user
    // aborted it: those responses will never come.
    const orphans = () => {
      if (unanswered.size === 0 || signal?.aborted) return;
      const ids = [...unanswered].map((k) => JSON.parse(k) as unknown);
      const message = 'the event stream ended without a response';
      appEvent(emit, { event: 'stream-ended-without-response', exchange, ids });
      unanswered.clear();
      onOrphaned?.(ids, message);
    };
    // Transformer.cancel is in the streams standard and in Node, not yet in the TypeScript lib.
    const logging: Transformer<Uint8Array, Uint8Array> & { cancel?: (reason: unknown) => void } = {
      transform(chunk, controller) {
        for (const e of events.push(chunk)) event(e);
        controller.enqueue(chunk);
      },
      flush() {
        done();
        const rest = events.flush();
        if (rest) event(rest);
        orphans();
      },
      // The stream ended by error (the server dropped the connection mid-event)
      // or was cancelled: flush never runs, so the bytes that did arrive are
      // logged here (P1), and the listener goes as it would at a clean end.
      cancel() {
        done();
        const rest = events.flush();
        if (rest) event(rest);
        orphans();
      },
    };
    const logged = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(logging));
    return rebuilt(logged);
  };
}

/** The ids, as id keys, of the requests a POST body carried: one, or a batch's. */
function requestIds(body: Uint8Array | { unrecorded: string }): Set<string> {
  const out = new Set<string>();
  if (!(body instanceof Uint8Array) || body.length === 0) return out;
  try {
    const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      const msg = m as { id?: unknown; method?: unknown } | null;
      if (msg && typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null) out.add(idKey(msg.id));
    }
  } catch {
    // Not JSON: nothing this stream owes.
  }
  return out;
}

/** The ids, as id keys, of the responses one event carried. */
function responseIds(bytes: Uint8Array): string[] {
  const data = sseEventData(bytes);
  if (data === null) return [];
  try {
    const parsed = JSON.parse(data) as unknown;
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter((m) => m && typeof m === 'object' && (m as { method?: unknown }).method === undefined && (m as { id?: unknown }).id !== undefined)
      .map((m) => idKey((m as { id: unknown }).id));
  } catch {
    return [];
  }
}

/**
 * The tasks extension requires Mcp-Name to equal the taskId on a modern task
 * request over Streamable HTTP. The SDK's transport derives Mcp-Name from a
 * name or uri only, and refuses a caller's own, so it is added here, on the
 * way out, before the logging fetch records the request. Only a modern
 * request (its body carries the _meta protocol-version claim) that names a
 * task and has no Mcp-Name yet.
 */
export function taskNameFetch(base: typeof fetch): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body !== 'string' || !init.body.includes('"tasks/')) return base(input, init);
    let message: { method?: unknown; params?: { taskId?: unknown; _meta?: Record<string, unknown> } };
    try {
      message = JSON.parse(init.body);
    } catch {
      return base(input, init);
    }
    const taskId = message?.params?.taskId;
    const modern = typeof message?.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === 'string';
    if (typeof message?.method !== 'string' || !message.method.startsWith('tasks/') || typeof taskId !== 'string' || !modern) return base(input, init);
    const headers = new Headers(init.headers);
    if (!headers.has('mcp-name')) headers.set('mcp-name', encodeHeaderValue(taskId));
    return base(input, { ...init, headers });
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
  const calls = new CallTracker();
  const secretHeaders = opts.secretHeaders ?? {};
  // One logging fetch for every attempt, so exchange numbers keep counting.
  const orphaned = (ids: unknown[], message: string) => { for (const id of ids) calls.abandon(id, message); };
  const fetchOption = { fetch: taskNameFetch(loggingFetch(emit ?? (() => undefined), Object.keys(secretHeaders), fetch, orphaned)) };

  const attempt = async (negotiate: boolean) => {
    const client = makeClient(mod.Client, info, { negotiate, probeTimeoutMs: opts.probeTimeoutMs, onListChanged: opts.onListChanged, onServerRequest: opts.onServerRequest });
    const transport = new Transport(new URL(opts.url), { requestInit: { headers: { ...opts.headers, ...secretHeaders } }, ...fetchOption });
    try {
      await client.connect(tap(transport, opts.onFrame, opts.onFrameError, calls, opts.onNotification));
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
  return describe(client, calls, opts.kind ?? 'streamable-http');
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
  const calls = new CallTracker();
  const client = makeClient(Client, { name: opts.clientName ?? 'mcp-explorer', version: opts.clientVersion ?? '0.0.0' }, { negotiate: era === 'auto', probeTimeoutMs: opts.probeTimeoutMs, onListChanged: opts.onListChanged, onServerRequest: opts.onServerRequest });

  try {
    await client.connect(tap(inner, opts.onFrame, opts.onFrameError, calls, opts.onNotification));
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
  // Assigned, not spread: a spread would read the logLevel getter once and
  // keep that value forever.
  return Object.assign(await describe(client, calls, 'stdio'), { pid: watch.pid, startedAt: watch.spawnedAt });
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
