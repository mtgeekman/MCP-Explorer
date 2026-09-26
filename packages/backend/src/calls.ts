// The call pipeline (plan phase 07): a tool call, a prompt get or a resource
// read, started by the user, confirmed when the tool is not declared
// read-only (D7), recorded as a sequence of rounds (D23), cancellable, and
// never retried on its own (P2). A call answered with input_required waits
// for the person's answers, and only their "Send answers and retry" sends the
// next round (phase 08 decision 6); after the workspace's soft cap of rounds
// it pauses and asks whether to go on (D21, decision 8).
import {
  CALL_METHOD, callParams, validateAgainst,
  type CallKind, type CallOutcome, type CallProgress, type Connection, type NormalizedSurface, type Verdict,
} from '../../protocol/dist/index.js';
import {
  latestCapture, listCalls, listServerRequests, readCall, readSettings,
  type CallRecord, type CallStatus, type CallSummary, type HistoryRecorder, type PurgeResult, type ServerRequestRecord, type Workspace,
} from '../../storage/dist/index.js';
import type { LogUnit } from './api.js';

export interface CallStart {
  serverId: string;
  kind: CallKind;
  /** A tool or prompt name, or a resource URI. */
  target: string;
  args?: Record<string, unknown>;
  /** The user has seen the confirm for this call and said go. */
  confirmed?: boolean;
}

/** What the confirm shows (board 6.2B): the params call() will send, the hints, and why it asks. */
export interface ConfirmPrompt {
  method: string;
  params: Record<string, unknown>;
  /** The tool's annotations as the server declared them, untrusted (D7). */
  annotations?: unknown;
  why: string;
  /** The arguments against the tool's inputSchema; advisory (decision 4). */
  argumentsCheck?: Verdict;
}

export type StartReply = { started: true; callId: number } | { started: false; confirm: ConfirmPrompt };

/** Where a call stands in this session, beyond what storage holds. */
export interface LiveCall {
  status: 'running' | 'awaiting-input';
  progress?: CallProgress;
  /** While awaiting input: what the server asked for, held here even when storage withholds it (D30). */
  input?: AwaitedInput;
  /** The soft cap stopped the call here (D21, board 6.4): Keep answering or Stop. */
  paused?: { rounds: number; cap: number };
}

/** The last round's InputRequiredResult, as the person answers it. */
export interface AwaitedInput {
  /** The round that asked. */
  round: number;
  /** The requests by the server's keys; null when the server sent none (a requestState-only result). */
  inputRequests: Record<string, unknown> | null;
  /** Whether a requestState came, which the retry echoes. Its value never leaves the backend. */
  hasRequestState: boolean;
  /** Why the result cannot be answered, when it is malformed: it can only be stopped. */
  malformed?: string;
}

export interface CallView {
  call: CallRecord;
  /** Requests the server sent the client during this call (legacy era; D23 amended). */
  serverRequests: ServerRequestRecord[];
  live?: LiveCall;
  /** This session's result when the stored one is withheld under the opt-out (D30). */
  sessionResult?: unknown;
  /** The SDK refused this result; the app shows it anyway (decision 1). Known for this session's calls only. */
  sdkRejected?: string;
  /** structuredContent against the tool's outputSchema in the latest capture. Absent when there is nothing to check. */
  outputCheck?: Verdict;
}

/** Why call.changed fired. 'progress' and 'request' (a server request linked to it arrived or ended) leave the call's status as it was. */
export type CallChange = 'started' | 'progress' | 'waiting' | 'ended' | 'request';

export interface CallEvents {
  /** A call started, progressed, began waiting for input, or ended: read calls.get again. */
  changed(serverId: string, callId: number, reason: CallChange): void;
  /** Finishing a call ran retention (D24); this is what it deleted. */
  purged(result: PurgeResult): void;
}

export interface CallSessions {
  session(serverId: string): { conn: Connection; recorder: HistoryRecorder; connectionId: number } | undefined;
  partialCapture(serverId: string): { surface: NormalizedSurface } | undefined;
}

type Tool = NormalizedSurface['tools'][number];

/**
 * Whether a call confirms first (D7, decision 5). Annotations are hints the
 * server declares about itself: this reads them, and trusts nothing. Only the
 * boolean `true` counts as read-only; a tool the capture does not know, or
 * one with no annotations, is not read-only.
 */
export function confirmPolicy(kind: CallKind, tool: Tool | undefined, askBeforeCalls: boolean): { confirm: boolean; why: string } {
  if (kind !== 'tool') return { confirm: false, why: 'Getting a prompt and reading a resource do not ask first: they are reads, not tool calls.' };
  if (!askBeforeCalls) return { confirm: false, why: '"Ask before calls" is off for this workspace.' };
  if (!tool) return { confirm: true, why: 'This tool is not in the latest capture, so nothing declares it read-only.' };
  const hints = tool.annotations as { readOnlyHint?: unknown } | undefined;
  if (hints?.readOnlyHint === true) return { confirm: false, why: 'The tool declares readOnlyHint: true. The app does not verify it.' };
  if (hints === undefined) return { confirm: true, why: 'The tool declares no annotations, so it is treated as not read-only.' };
  return { confirm: true, why: 'The tool does not declare readOnlyHint: true.' };
}

interface Running {
  serverId: string;
  recorder: HistoryRecorder;
  conn: Connection;
  abort: AbortController;
  live: LiveCall;
  kind: CallKind;
  target: string;
  args?: Record<string, unknown>;
  /** The last round's inputRequests and requestState exactly as the tap saw them. */
  awaited?: { round: number; inputRequests?: Record<string, unknown>; requestState?: string };
  /** The round at which the call started, or was last continued past the cap. */
  capBase: number;
}

/** A person's answers could not be sent as given. */
export class AnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerError';
  }
}

/** What storage does not keep for this session's calls, newest last: withheld results and the SDK's objections. */
const SESSION_RESULTS = 50;

export class CallPipeline {
  private readonly running = new Map<number, Running>();
  private readonly session = new Map<number, { result?: unknown; sdkRejected?: string }>();

  constructor(private readonly ws: Workspace, private readonly sessions: CallSessions, private readonly events: Partial<CallEvents> = {}) {}

  /** The tool as the panel shows it: this session's partial capture first, then the latest whole one. */
  private tool(serverId: string, name: string): Tool | undefined {
    const surface = this.sessions.partialCapture(serverId)?.surface ?? latestCapture(this.ws, serverId)?.surface;
    return surface?.tools.find((t) => t.name === name);
  }

  /**
   * Starts a call, or says it must be confirmed first. Resolves as soon as the
   * request is on its way; the outcome arrives through `changed`.
   */
  async start(req: CallStart): Promise<StartReply> {
    const s = this.sessions.session(req.serverId);
    if (!s) throw new Error(`server ${req.serverId} is not connected`);
    const tool = req.kind === 'tool' ? this.tool(req.serverId, req.target) : undefined;
    const policy = confirmPolicy(req.kind, tool, readSettings(this.ws).askBeforeCalls);
    if (policy.confirm && !req.confirmed) {
      return {
        started: false,
        confirm: {
          method: CALL_METHOD[req.kind],
          params: callParams(req),
          ...(tool?.annotations === undefined ? {} : { annotations: tool.annotations }),
          why: policy.why,
          ...(tool ? { argumentsCheck: await validateAgainst(tool.inputSchema, req.args ?? {}) } : {}),
        },
      };
    }

    const callId = s.recorder.beginCall(req.kind, req.target);
    const run: Running = {
      serverId: req.serverId, recorder: s.recorder, conn: s.conn, abort: new AbortController(), live: { status: 'running' },
      kind: req.kind, target: req.target, ...(req.args === undefined ? {} : { args: req.args }), capBase: 0,
    };
    this.running.set(callId, run);
    this.send(callId, run);
    this.events.changed?.(req.serverId, callId, 'started');
    return { started: true, callId };
  }

  /**
   * Sends a round: the first, or a retry carrying the person's answers and
   * the server's requestState exactly as it came (D16). The retry repeats the
   * call's own arguments; the SDK gives it a new id.
   */
  private send(callId: number, run: Running, retry?: { inputResponses?: Record<string, unknown>; requestState?: string }): void {
    const seq = run.recorder.beginRound(callId, run.args);
    const outcome = run.conn.call({
      kind: run.kind, target: run.target, args: run.args, signal: run.abort.signal,
      ...(retry?.inputResponses === undefined ? {} : { inputResponses: retry.inputResponses }),
      ...(retry?.requestState === undefined ? {} : { requestState: retry.requestState }),
      onProgress: (progress) => { run.live.progress = progress; this.events.changed?.(run.serverId, callId, 'progress'); },
    });
    void outcome.then((o) => this.settle(callId, seq, run, o));
  }

  /**
   * The person's "Send answers and retry" (board 6.3). Every request the
   * server made needs an answer under its own key (decision 6); a
   * requestState-only result is retried with no answers. Nothing is filled
   * in: the answers go as given.
   */
  answer(callId: number, inputResponses?: Record<string, unknown>): void {
    const run = this.running.get(callId);
    if (!run || run.live.status !== 'awaiting-input' || !run.awaited) throw new Error(`call ${callId} is not waiting for input`);
    if (run.live.paused) throw new AnswerError(`call ${callId} is paused at the round limit: keep answering or stop it first`);
    if (run.live.input?.malformed) throw new AnswerError(`call ${callId} cannot be answered: ${run.live.input.malformed}`);
    if (this.sessions.session(run.serverId)?.conn !== run.conn) throw new AnswerError(`the session call ${callId} ran on has ended`);
    const asked = run.awaited.inputRequests;
    if (asked === undefined) {
      if (inputResponses !== undefined && Object.keys(inputResponses).length > 0) throw new AnswerError('the server asked for no input; the retry carries its requestState alone');
    } else {
      const given = inputResponses ?? {};
      const missing = Object.keys(asked).filter((k) => !Object.hasOwn(given, k));
      const extra = Object.keys(given).filter((k) => !Object.hasOwn(asked, k));
      if (missing.length) throw new AnswerError(`no answer for ${missing.join(', ')}`);
      if (extra.length) throw new AnswerError(`the server did not ask for ${extra.join(', ')}`);
      run.recorder.answerRound(callId, run.awaited.round, given);
    }
    const requestState = run.awaited.requestState;
    run.awaited = undefined;
    run.live = { status: 'running' };
    this.send(callId, run, { ...(asked === undefined ? {} : { inputResponses: inputResponses ?? {} }), ...(requestState === undefined ? {} : { requestState }) });
    this.events.changed?.(run.serverId, callId, 'started');
  }

  /** "Keep answering" at the soft cap: the call may take as many rounds again before it pauses next. */
  continue(callId: number): void {
    const run = this.running.get(callId);
    if (!run?.live.paused) throw new Error(`call ${callId} is not paused at the round limit`);
    run.capBase = run.live.paused.rounds;
    const { paused: _, ...rest } = run.live;
    run.live = rest;
    this.events.changed?.(run.serverId, callId, 'waiting');
  }

  /** Calls running on this connection and not waiting for input: a server's request may belong to one of them. */
  runningOn(connectionId: number): number[] {
    return [...this.running].filter(([, r]) => r.recorder.connectionId === connectionId && r.live.status === 'running').map(([id]) => id);
  }

  /** The user's Cancel: the era's cancellation goes out, and the server may still finish (board 6.5). */
  cancel(callId: number): void {
    const run = this.running.get(callId);
    if (!run || run.live.status !== 'running') throw new Error(`call ${callId} is not running`);
    run.abort.abort('cancelled by the user');
  }

  /** The user stops a call waiting for input: nothing is sent. At the soft cap it ends capped, elsewhere abandoned (decision 8). */
  stop(callId: number): void {
    const run = this.running.get(callId);
    if (!run || run.live.status !== 'awaiting-input') throw new Error(`call ${callId} is not waiting for input`);
    this.end(callId, run, run.live.paused ? 'capped' : 'abandoned');
  }

  /**
   * A server's session ended: calls waiting for input end interrupted. A call
   * still running ends by its own outcome, which the session's end fails.
   */
  sessionEnded(serverId: string): void {
    for (const [callId, run] of this.running) {
      if (run.serverId === serverId && run.live.status === 'awaiting-input') this.end(callId, run, 'interrupted');
    }
  }

  list(serverId: string, opts: { before?: number; limit?: number }): (CallSummary & { live?: LiveCall })[] {
    return listCalls(this.ws, serverId, opts).map((c) => {
      const run = this.running.get(c.id);
      return run ? { ...c, live: { ...run.live } } : c;
    });
  }

  async view(callId: number): Promise<CallView | null> {
    const call = readCall(this.ws, callId);
    if (!call) return null;
    const run = this.running.get(callId);
    const kept = this.session.get(callId);
    // The call's result is its last round's: earlier rounds asked for input.
    const last = call.roundRecords[call.roundRecords.length - 1];
    const result = (last?.result ?? kept?.result) as { structuredContent?: unknown; isError?: unknown } | undefined;
    let outputCheck: Verdict | undefined;
    if (call.kind === 'tool' && result && result.structuredContent !== undefined) {
      const schema = latestCapture(this.ws, call.serverId)?.surface.tools.find((t) => t.name === call.target)?.outputSchema;
      if (schema !== undefined) outputCheck = await validateAgainst(schema, result.structuredContent);
    }
    return {
      call,
      serverRequests: listServerRequests(this.ws, { callId }),
      ...(run ? { live: { ...run.live } } : {}),
      ...(last && last.result === null && kept?.result !== undefined ? { sessionResult: kept.result } : {}),
      ...(kept?.sdkRejected ? { sdkRejected: kept.sdkRejected } : {}),
      ...(outputCheck ? { outputCheck } : {}),
    };
  }

  private settle(callId: number, seq: number, run: Running, o: CallOutcome): void {
    try {
      if (o.kind === 'result') {
        const r = o.result;
        const inputRequired = r.resultType === 'input_required';
        run.recorder.finishRound(callId, seq, {
          result: r,
          ...(typeof r.resultType === 'string' ? { resultType: r.resultType } : {}),
          ...(inputRequired && r.inputRequests !== undefined ? { inputRequests: r.inputRequests } : {}),
          ...(inputRequired && typeof r.requestState === 'string' ? { requestState: r.requestState } : {}),
        });
        // Memory holds only what storage does not: a result withheld under the
        // opt-out (D30), and the SDK's objection, which has no column (R07-3).
        const withheld = !readSettings(this.ws).persistResults;
        if (withheld || o.sdkRejected) this.keep(callId, { ...(withheld ? { result: r } : {}), ...(o.sdkRejected ? { sdkRejected: o.sdkRejected } : {}) });
        if (inputRequired && this.sessions.session(run.serverId)?.conn === run.conn) {
          // The round is recorded and the call waits for the person (decision 6).
          this.await(callId, seq, run, r);
          return;
        }
        this.end(callId, run, inputRequired ? 'interrupted' : 'completed');
      } else if (o.kind === 'error') {
        run.recorder.finishRound(callId, seq, { error: o.error });
        this.end(callId, run, 'error');
      } else if (o.kind === 'cancelled') {
        run.recorder.finishRound(callId, seq, { error: { cancelled: true, reason: 'cancelled by the user' } });
        this.end(callId, run, 'cancelled');
      } else {
        // No response: the session ended under the call, or the request never went out.
        const ended = this.sessions.session(run.serverId)?.conn !== run.conn;
        run.recorder.finishRound(callId, seq, { error: { message: o.message } });
        this.end(callId, run, ended ? 'interrupted' : 'error');
      }
    } catch (e) {
      // The workspace closed under the call; the next open marks it interrupted.
      this.running.delete(callId);
      process.emitWarning(`call ${callId} could not be recorded as finished: ${e instanceof Error ? e.message : String(e)}`, 'MCPExplorerCallWarning');
    }
  }

  /** Holds what the retry needs, exactly as the tap saw it, and pauses at the soft cap (D21). */
  private await(callId: number, seq: number, run: Running, r: Record<string, unknown>): void {
    const requests = r.inputRequests;
    const state = r.requestState;
    const input: AwaitedInput = { round: seq, inputRequests: null, hasRequestState: typeof state === 'string' };
    if (requests !== undefined && (typeof requests !== 'object' || requests === null || Array.isArray(requests))) {
      input.malformed = 'inputRequests is not an object of requests by key.';
    } else if (requests !== undefined) {
      input.inputRequests = requests as Record<string, unknown>;
    }
    if (state !== undefined && typeof state !== 'string') input.malformed = 'requestState is not a string.';
    if (requests === undefined && state === undefined) input.malformed = 'The result carries neither inputRequests nor requestState; the specification requires one.';
    run.awaited = {
      round: seq,
      ...(input.inputRequests ? { inputRequests: input.inputRequests } : {}),
      ...(typeof state === 'string' ? { requestState: state } : {}),
    };
    const cap = readSettings(this.ws).mrtrSoftCap;
    run.live = { status: 'awaiting-input', input, ...(seq - run.capBase >= cap ? { paused: { rounds: seq, cap } } : {}) };
    this.events.changed?.(run.serverId, callId, 'waiting');
  }

  private end(callId: number, run: Running, status: CallStatus): void {
    this.running.delete(callId);
    try {
      this.events.purged?.(run.recorder.finishCall(callId, status));
    } finally {
      this.events.changed?.(run.serverId, callId, 'ended');
    }
  }

  private keep(callId: number, entry: { result?: unknown; sdkRejected?: string }): void {
    this.session.set(callId, entry);
    while (this.session.size > SESSION_RESULTS) this.session.delete(this.session.keys().next().value!);
  }
}

/** The request of a call's first round exactly as it was sent, and a curl command when it went over HTTP (decision 8). */
export interface CallExport {
  /** Null when the request never reached the wire, or its unit was purged. */
  bytes: Uint8Array | null;
  curl?: string;
  /** Environment variables the curl command expects, one per secret header. */
  secretVariables?: string[];
  reason?: string;
}

const SKIPPED_HEADERS = new Set(['content-length', 'host', 'connection', 'accept-encoding', 'keep-alive', 'transfer-encoding']);
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** `<secret: x-api-key>` as the log records it (D35) becomes MCP_SECRET_X_API_KEY. */
const secretVariable = (header: string) => `MCP_SECRET_${header.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/**
 * A curl command replaying an HTTP request unit: its URL, its headers as
 * logged with each secret as a variable, and its exact body. Nothing is
 * rebuilt; a secret value never appears, since the log never had it (D35).
 */
export function curlFor(unit: LogUnit): { curl: string; secretVariables: string[] } | undefined {
  const http = unit.http;
  if (!http?.url || unit.bytes === null) return undefined;
  const secretVariables: string[] = [];
  const parts = ['curl', '-sS', '-X', http.method ?? 'POST', shellQuote(http.url)];
  for (const [name, value] of Object.entries(http.headers ?? {})) {
    if (SKIPPED_HEADERS.has(name.toLowerCase())) continue;
    if (value === `<secret: ${name}>`) {
      const v = secretVariable(name);
      secretVariables.push(v);
      parts.push('-H', `"${name}: $${v}"`);
    } else {
      parts.push('-H', shellQuote(`${name}: ${value}`));
    }
  }
  parts.push('--data-binary', shellQuote(Buffer.from(unit.bytes).toString('utf8')));
  return { curl: parts.join(' '), secretVariables };
}
