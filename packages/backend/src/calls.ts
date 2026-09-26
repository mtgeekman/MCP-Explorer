// The call pipeline (plan phase 07): a tool call, a prompt get or a resource
// read, started by the user, confirmed when the tool is not declared
// read-only (D7), recorded as a sequence of rounds (D23), cancellable, and
// never retried on its own (P2). The human half of MRTR is phase 08: here a
// call answered with input_required stops at round 1 and waits.
import {
  CALL_METHOD, callParams, validateAgainst,
  type CallKind, type CallOutcome, type CallProgress, type Connection, type NormalizedSurface, type Verdict,
} from '../../protocol/dist/index.js';
import {
  latestCapture, listCalls, readCall, readSettings,
  type CallRecord, type CallStatus, type CallSummary, type HistoryRecorder, type Workspace,
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
}

export interface CallView {
  call: CallRecord;
  live?: LiveCall;
  /** This session's result when the stored one is withheld under the opt-out (D30). */
  sessionResult?: unknown;
  /** The SDK refused this result; the app shows it anyway (decision 1). Known for this session's calls only. */
  sdkRejected?: string;
  /** structuredContent against the tool's outputSchema in the latest capture. Absent when there is nothing to check. */
  outputCheck?: Verdict;
}

export interface CallEvents {
  /** A call started, progressed, or ended: read calls.get again. */
  changed(serverId: string, callId: number): void;
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
}

/** Results kept for this session's calls, newest last, so a withheld result can still be read while the app runs. */
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
    const seq = s.recorder.beginRound(callId, req.args);
    const run: Running = { serverId: req.serverId, recorder: s.recorder, conn: s.conn, abort: new AbortController(), live: { status: 'running' } };
    this.running.set(callId, run);
    const outcome = s.conn.call({
      kind: req.kind, target: req.target, args: req.args, signal: run.abort.signal,
      onProgress: (progress) => { run.live.progress = progress; this.events.changed?.(req.serverId, callId); },
    });
    this.events.changed?.(req.serverId, callId);
    void outcome.then((o) => this.settle(callId, seq, run, o));
    return { started: true, callId };
  }

  /** The user's Cancel: the era's cancellation goes out, and the server may still finish (board 6.5). */
  cancel(callId: number): void {
    const run = this.running.get(callId);
    if (!run || run.live.status !== 'running') throw new Error(`call ${callId} is not running`);
    run.abort.abort('cancelled by the user');
  }

  /** The user stops a call waiting for input (decision 6): nothing is sent, and it ends abandoned. */
  stop(callId: number): void {
    const run = this.running.get(callId);
    if (!run || run.live.status !== 'awaiting-input') throw new Error(`call ${callId} is not waiting for input`);
    this.end(callId, run, 'abandoned');
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
    const first = call.roundRecords[0];
    const result = (first?.result ?? kept?.result) as { structuredContent?: unknown; isError?: unknown } | undefined;
    let outputCheck: Verdict | undefined;
    if (call.kind === 'tool' && result && result.structuredContent !== undefined) {
      const schema = latestCapture(this.ws, call.serverId)?.surface.tools.find((t) => t.name === call.target)?.outputSchema;
      if (schema !== undefined) outputCheck = await validateAgainst(schema, result.structuredContent);
    }
    return {
      call,
      ...(run ? { live: { ...run.live } } : {}),
      ...(first && first.result === null && kept?.result !== undefined ? { sessionResult: kept.result } : {}),
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
        this.keep(callId, { result: r, ...(o.sdkRejected ? { sdkRejected: o.sdkRejected } : {}) });
        if (inputRequired && this.sessions.session(run.serverId)?.conn === run.conn) {
          // Decision 6: round 1 is recorded and the call waits. Phase 08 answers it.
          run.live = { status: 'awaiting-input' };
          this.events.changed?.(run.serverId, callId);
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

  private end(callId: number, run: Running, status: CallStatus): void {
    this.running.delete(callId);
    try {
      run.recorder.finishCall(callId, status);
    } finally {
      this.events.changed?.(run.serverId, callId);
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
