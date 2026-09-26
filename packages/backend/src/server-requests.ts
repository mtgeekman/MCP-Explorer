// Requests a legacy-era server sends the client (phase 08 decisions 1, 4, 5,
// 11): each is recorded, shown, and waits for a person. The answer goes back
// only when they send it; a refusal is the error they chose. Nothing here
// answers on anyone's behalf (P2), and nothing times out.
import type { ServerAnswer, ServerRequest } from '../../protocol/dist/index.js';
import { listServerRequests, readServerRequest, type HistoryRecorder, type ServerRequestRecord, type Workspace } from '../../storage/dist/index.js';

/** A server request as the renderer lists it: while pending, its params from memory even when storage withholds them (D30). */
export interface ServerRequestRow extends ServerRequestRecord {
  /** Pending in this session, so it can still be answered. */
  live?: { params: unknown };
}

export interface ServerRequestEvents {
  /** A request arrived, or ended: list it again. `callId` is the call it is linked to. */
  changed(serverId: string, requestId: number, callId: number | null): void;
}

interface Pending {
  serverId: string;
  recorder: HistoryRecorder;
  request: ServerRequest;
  callId: number | null;
  resolve: (answer: ServerAnswer) => void;
}

/** An answer the person gave that cannot be sent as it is. */
export class InvalidAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAnswerError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class ServerRequests {
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly ws: Workspace,
    /** The calls running on a connection, to link a request to the only one. */
    private readonly runningOn: (connectionId: number) => number[],
    private readonly events: Partial<ServerRequestEvents> = {},
    /** The open task call on a connection with this task id (phase 10), when there is one. */
    private readonly taskCall: (connectionId: number, taskId: string) => number | undefined = () => undefined,
  ) {}

  /**
   * A request arrived. It is linked to a call only when exactly one is
   * running on its connection: a stdio request says nothing of which call it
   * belongs to (decision 4). A request that names a task in
   * _meta["io.modelcontextprotocol/related-task"] (2025-11-25) is linked to
   * that task's call instead. Resolves with the person's answer.
   */
  receive(serverId: string, recorder: HistoryRecorder, request: ServerRequest): Promise<ServerAnswer> {
    const related = (request.params as { _meta?: Record<string, { taskId?: unknown } | undefined> } | undefined)?._meta?.['io.modelcontextprotocol/related-task']?.taskId;
    const byTask = typeof related === 'string' ? this.taskCall(recorder.connectionId, related) : undefined;
    const running = this.runningOn(recorder.connectionId);
    const callId = byTask ?? (running.length === 1 ? running[0] : null);
    let id: number;
    try {
      id = recorder.receiveRequest(request.id, request.method, request.params, callId);
    } catch (e) {
      // Throwing here would make the SDK answer -32603, a reply nobody gave
      // (P2). With nowhere to record it, the request waits unanswered until
      // the session ends; the wire log still has its frame (R08-5).
      process.emitWarning(`server request ${JSON.stringify(request.id)} (${request.method}) could not be recorded, and waits unanswered: ${e instanceof Error ? e.message : String(e)}`, 'MCPExplorerCallWarning');
      return new Promise<never>(() => undefined);
    }
    return new Promise<ServerAnswer>((resolve) => {
      this.pending.set(id, { serverId, recorder, request, callId, resolve });
      this.events.changed?.(serverId, id, callId);
      // The server gave up on it: the SDK sends nothing after this, and the
      // person can no longer answer. A cancel can land before the SDK hands
      // the request over, and an aborted signal never fires again (R08-1).
      if (request.signal.aborted) this.finish(id, 'cancelled');
      else request.signal.addEventListener('abort', () => this.finish(id, 'cancelled'), { once: true });
    });
  }

  /** The person's answer: a result, or a refusal with the error they chose. */
  answer(requestId: number, answer: ServerAnswer): void {
    const p = this.pending.get(requestId);
    if (!p) throw new Error(`server request ${requestId} is not waiting for an answer`);
    // Stored and sent as JSON: a value JSON cannot hold (a BigInt, a cycle)
    // would fail both after the request had left the pending set.
    try {
      JSON.stringify(answer);
    } catch (e) {
      throw new InvalidAnswerError(`the answer cannot be stored as JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if ('error' in answer) {
      const e = answer.error as { code?: unknown; message?: unknown };
      if (!Number.isSafeInteger(e?.code)) throw new InvalidAnswerError('an error needs a whole-number code');
      if (typeof e.message !== 'string') throw new InvalidAnswerError('an error needs a message');
      // The SDK's legacy encoder sends -32002 as -32602, so the code the
      // person chose would not be the code the server got (R08-8).
      if (e.code === -32002) throw new InvalidAnswerError('the client library sends -32002 as -32602 on this era; choose another code');
      this.finish(requestId, 'refused', { error: answer.error });
    } else if ('result' in answer && isObject(answer.result)) {
      this.finish(requestId, 'answered', answer.result);
    } else {
      throw new InvalidAnswerError('a result is a JSON object');
    }
    p.resolve(answer);
  }

  /**
   * A server's session ended: what it asked and nobody answered ends
   * interrupted. Nothing is sent; there is nothing to send it on.
   */
  sessionEnded(serverId: string): void {
    for (const [id, p] of this.pending) {
      if (p.serverId === serverId) this.finish(id, 'interrupted');
    }
  }

  /**
   * A server's requests, newest first, the pending ones with their params.
   * Every pending request is listed whatever the limit: one pushed off the
   * page could never be answered (R08-2).
   */
  list(serverId: string, limit?: number): ServerRequestRow[] {
    const page = listServerRequests(this.ws, { serverId, limit });
    const onPage = new Set(page.map((r) => r.id));
    const older = [...this.pending].filter(([id, p]) => p.serverId === serverId && !onPage.has(id))
      .flatMap(([id]) => readServerRequest(this.ws, id) ?? []);
    return [...page, ...older].sort((a, b) => b.id - a.id).map((r) => this.row(r));
  }

  get(requestId: number): ServerRequestRow | null {
    const r = readServerRequest(this.ws, requestId);
    return r ? this.row(r) : null;
  }

  private row(r: ServerRequestRecord): ServerRequestRow {
    const p = this.pending.get(r.id);
    return p ? { ...r, live: { params: p.request.params } } : r;
  }

  private finish(requestId: number, status: 'answered' | 'refused' | 'cancelled' | 'interrupted', response?: unknown): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    try {
      p.recorder.finishRequest(requestId, status, response);
    } catch (e) {
      // The workspace closed under it; the next open marks it interrupted.
      process.emitWarning(`server request ${requestId} could not be recorded as ${status}: ${e instanceof Error ? e.message : String(e)}`, 'MCPExplorerCallWarning');
    }
    this.events.changed?.(p.serverId, requestId, p.callId);
  }
}
