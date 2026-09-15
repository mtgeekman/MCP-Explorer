import { StorageError } from './errors.js';
import { purgeHistory, type PurgeResult } from './retention.js';
import type { Workspace } from './workspace-db.js';

/**
 * Recording connections, calls, rounds and frames as they happen (D23, D30,
 * P1). One recorder per open connection.
 *
 * Frames arrive from the transport tap without knowing which call they belong
 * to: the SDK assigns JSON-RPC ids after the call pipeline has asked for a
 * request. So a round declares what it is about to send -- method and target
 * -- and the next outgoing request with that method and target is bound to
 * it, first come first served. The response is then bound by JSON-RPC id.
 */

/** The three methods whose responses are results, and the only three that can return InputRequiredResult (D16, D30). */
export const RESULT_METHODS: readonly string[] = ['tools/call', 'prompts/get', 'resources/read'];

export type CallKind = 'tool' | 'prompt' | 'resource';
export type CallStatus = 'completed' | 'error' | 'abandoned' | 'capped';

const METHOD_FOR_KIND: Record<CallKind, string> = { tool: 'tools/call', prompt: 'prompts/get', resource: 'resources/read' };

/** A recorder was used out of order: a round on a finished call, a call finished twice. */
export class HistoryStateError extends StorageError {}

export interface RoundOutcome {
  /** The complete result or InputRequiredResult, as received. */
  result?: unknown;
  resultType?: string;
  inputRequests?: unknown;
  /** Opaque, echoed byte-exact (D16): stored as the bytes of this string. */
  requestState?: string;
  error?: unknown;
}

interface Binding { callId: number; seq: number; method: string }
interface JsonRpc { id?: string | number | null; method?: string; params?: { name?: unknown; uri?: unknown } }

const targetOf = (method: string, params: JsonRpc['params']): string | undefined =>
  method === 'resources/read' ? (typeof params?.uri === 'string' ? params.uri : undefined)
    : typeof params?.name === 'string' ? params.name : undefined;

/** A JSON-RPC id as text that keeps its type: 7 is "7", "7" is "\"7\"". */
const idText = (id: JsonRpc['id']) => (id === undefined ? null : JSON.stringify(id));

export class HistoryRecorder {
  readonly connectionId: number;
  private readonly pending = new Map<string, Binding[]>();
  private readonly sentRequests = new Map<string, { method: string; binding?: Binding }>();
  private readonly receivedRequests = new Map<string, string>();
  private readonly openCalls = new Set<number>();

  private constructor(private readonly ws: Workspace, readonly serverId: string, connectionId: number, private readonly now: () => number) {
    this.connectionId = connectionId;
  }

  /** Records a new connection and returns its recorder. */
  static open(ws: Workspace, serverId: string, now: () => number = Date.now): HistoryRecorder {
    const id = ws.db.prepare('INSERT INTO connection (server_id, opened_at) VALUES (?, ?)').run(serverId, now()).lastInsertRowid;
    return new HistoryRecorder(ws, serverId, Number(id), now);
  }

  /** Records what negotiation settled on (D20). */
  negotiated(revision: string, era: 'legacy' | 'modern'): void {
    this.ws.db.prepare('UPDATE connection SET negotiated_revision = ?, era = ? WHERE id = ?').run(revision, era, this.connectionId);
  }

  close(): void {
    this.ws.db.prepare('UPDATE connection SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(this.now(), this.connectionId);
  }

  /** Whether results are withheld right now. Read per write, so a settings change applies at once. */
  private withholding(): boolean {
    return (this.ws.db.prepare('SELECT persist_results FROM workspace_meta WHERE id = 1').get() as { persist_results: number }).persist_results === 0;
  }

  /**
   * P1: every frame, in both directions. Shaped to be the transport tap's
   * FrameListener. A batch is recorded as its members.
   */
  frame = (direction: 'out' | 'in', frame: unknown): void => {
    for (const message of Array.isArray(frame) ? frame : [frame]) this.recordOne(direction, message as JsonRpc);
  };

  private recordOne(direction: 'out' | 'in', msg: JsonRpc): void {
    const id = idText(msg.id);
    const isRequest = typeof msg.method === 'string' && id !== null;
    const isResponse = typeof msg.method !== 'string' && id !== null;
    let method = typeof msg.method === 'string' ? msg.method : null;
    let binding: Binding | undefined;

    if (isRequest && direction === 'out') {
      binding = this.takePending(msg.method!, targetOf(msg.method!, msg.params));
      this.sentRequests.set(id!, { method: msg.method!, binding });
    } else if (isRequest && direction === 'in') {
      this.receivedRequests.set(id!, msg.method!);
    } else if (isResponse && direction === 'in') {
      const sent = this.sentRequests.get(id!);
      if (sent) {
        method = sent.method;
        binding = sent.binding;
        this.sentRequests.delete(id!);
      }
    } else if (isResponse && direction === 'out') {
      method = this.receivedRequests.get(id!) ?? null;
      this.receivedRequests.delete(id!);
    }

    // D30: a response to a result method is the result. Its body is withheld
    // under the opt-out; the row still says when it came and what it answered.
    // A response to a request this recorder never saw is withheld too: its
    // body may be a result, and nothing here can tell.
    const withheld = isResponse && direction === 'in' && (method === null || RESULT_METHODS.includes(method)) && this.withholding();
    this.ws.db.prepare(`
      INSERT INTO frame (connection_id, call_id, round_seq, direction, at, jsonrpc_id, method, message_json, result_withheld)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(this.connectionId, binding?.callId ?? null, binding?.seq ?? null, direction, this.now(), id, method,
      withheld ? null : JSON.stringify(msg), withheld ? 1 : 0);
  }

  private takePending(method: string, target: string | undefined): Binding | undefined {
    if (target === undefined) return undefined;
    const queue = this.pending.get(`${method}\u0000${target}`);
    return queue?.shift();
  }

  beginCall(kind: CallKind, target: string): number {
    const id = Number(this.ws.db.prepare(`
      INSERT INTO call (server_id, connection_id, kind, target, status, started_at) VALUES (?, ?, ?, ?, 'in_progress', ?)
    `).run(this.serverId, this.connectionId, kind, target, this.now()).lastInsertRowid);
    this.openCalls.add(id);
    return id;
  }

  /**
   * Starts the next round of a call and expects its request on the wire. The
   * first round carries the user's arguments; a retry repeats them with the
   * human's answers attached (D16).
   */
  beginRound(callId: number, args: unknown): number {
    const call = this.requireOpen(callId);
    const seq = (this.ws.db.prepare('SELECT coalesce(max(seq), 0) + 1 AS next FROM call_round WHERE call_id = ?').get(callId) as { next: number }).next;
    const unfinished = this.ws.db.prepare('SELECT seq FROM call_round WHERE call_id = ? AND finished_at IS NULL').get(callId);
    if (unfinished) throw new HistoryStateError(`call ${callId} already has an unfinished round`);
    this.ws.db.prepare('INSERT INTO call_round (call_id, seq, arguments_json, started_at) VALUES (?, ?, ?, ?)')
      .run(callId, seq, args === undefined ? null : JSON.stringify(args), this.now());
    const method = METHOD_FOR_KIND[call.kind];
    const key = `${method}\u0000${call.target}`;
    this.pending.set(key, [...(this.pending.get(key) ?? []), { callId, seq, method }]);
    return seq;
  }

  /**
   * Records what came back for a round. Under the opt-out (D30) the result,
   * the input requests and the request state are all withheld: an
   * InputRequiredResult is a result too, and a sampling request inside it can
   * carry tool output.
   */
  finishRound(callId: number, seq: number, outcome: RoundOutcome): void {
    this.requireOpen(callId);
    const withhold = this.withholding();
    const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
    const changed = this.ws.db.prepare(`
      UPDATE call_round SET result_json = ?, result_type = ?, input_requests_json = ?, request_state = ?, error_json = ?, finished_at = ?
      WHERE call_id = ? AND seq = ? AND finished_at IS NULL
    `).run(
      withhold ? null : json(outcome.result), outcome.resultType ?? null,
      withhold ? null : json(outcome.inputRequests),
      withhold || outcome.requestState === undefined ? null : Buffer.from(outcome.requestState, 'utf8'),
      json(outcome.error), this.now(), callId, seq,
    ).changes;
    if (changed === 0) throw new HistoryStateError(`call ${callId} has no unfinished round ${seq}`);
    // A round can finish without its request ever reaching the wire (the send
    // failed first). Its binding must go, or the next round's request binds to
    // this dead round instead.
    this.dropPending((b) => b.callId === callId && b.seq === seq);
  }

  /** The human's answers to a round's input requests, recorded before the retry that carries them. */
  answerRound(callId: number, seq: number, inputResponses: unknown): void {
    this.requireOpen(callId);
    const changed = this.ws.db.prepare('UPDATE call_round SET input_responses_json = ? WHERE call_id = ? AND seq = ? AND finished_at IS NOT NULL')
      .run(JSON.stringify(inputResponses), callId, seq).changes;
    if (changed === 0) throw new HistoryStateError(`call ${callId} has no finished round ${seq} to answer`);
  }

  /** Finishes the call, then applies retention, finishing a call being its other trigger (D24). */
  finishCall(callId: number, status: CallStatus): PurgeResult {
    this.requireOpen(callId);
    const unfinished = this.ws.db.prepare('SELECT seq FROM call_round WHERE call_id = ? AND finished_at IS NULL').get(callId);
    if (unfinished && status === 'completed') throw new HistoryStateError(`call ${callId} cannot complete with a round still waiting`);
    this.ws.db.transaction(() => {
      this.ws.db.prepare('UPDATE call_round SET finished_at = ? WHERE call_id = ? AND finished_at IS NULL').run(this.now(), callId);
      this.ws.db.prepare('UPDATE call SET status = ?, finished_at = ? WHERE id = ?').run(status, this.now(), callId);
    })();
    this.openCalls.delete(callId);
    this.dropPending((b) => b.callId === callId);
    return purgeHistory(this.ws, this.now);
  }

  private dropPending(matches: (b: Binding) => boolean): void {
    for (const [key, queue] of this.pending) {
      const kept = queue.filter((b) => !matches(b));
      if (kept.length) this.pending.set(key, kept); else this.pending.delete(key);
    }
  }

  private requireOpen(callId: number): { kind: CallKind; target: string } {
    if (!this.openCalls.has(callId)) throw new HistoryStateError(`call ${callId} is not open on this connection`);
    return this.ws.db.prepare('SELECT kind, target FROM call WHERE id = ?').get(callId) as { kind: CallKind; target: string };
  }
}
