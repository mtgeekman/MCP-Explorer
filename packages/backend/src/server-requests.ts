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
  ) {}

  /**
   * A request arrived. It is linked to a call only when exactly one is
   * running on its connection: a stdio request says nothing of which call it
   * belongs to (decision 4). Resolves with the person's answer.
   */
  receive(serverId: string, recorder: HistoryRecorder, request: ServerRequest): Promise<ServerAnswer> {
    const running = this.runningOn(recorder.connectionId);
    const callId = running.length === 1 ? running[0] : null;
    const id = recorder.receiveRequest(request.id, request.method, request.params, callId);
    return new Promise<ServerAnswer>((resolve) => {
      this.pending.set(id, { serverId, recorder, request, callId, resolve });
      // The server gave up on it: the SDK sends nothing after this, and the
      // person can no longer answer.
      request.signal.addEventListener('abort', () => this.finish(id, 'cancelled'), { once: true });
      this.events.changed?.(serverId, id, callId);
    });
  }

  /** The person's answer: a result, or a refusal with the error they chose. */
  answer(requestId: number, answer: ServerAnswer): void {
    const p = this.pending.get(requestId);
    if (!p) throw new Error(`server request ${requestId} is not waiting for an answer`);
    if ('error' in answer) {
      const e = answer.error as { code?: unknown; message?: unknown };
      if (!Number.isSafeInteger(e?.code)) throw new InvalidAnswerError('an error needs a whole-number code');
      if (typeof e.message !== 'string') throw new InvalidAnswerError('an error needs a message');
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

  /** A server's requests, newest first, the pending ones with their params. */
  list(serverId: string, limit?: number): ServerRequestRow[] {
    return listServerRequests(this.ws, { serverId, limit }).map((r) => this.row(r));
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
