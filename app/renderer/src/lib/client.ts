// The renderer's side of the backend message API (D32): requests matched to
// responses by id, events fanned out to listeners.
import type { ConnectFailure } from '../../../../packages/protocol/dist/index.js';
import type { Events, Message, Method, Requests } from '../../../../packages/backend/dist/index.js';

/** A request the backend refused. `name` is the error's class, which decides what the UI offers. */
export class BackendError extends Error {
  constructor(readonly errorName: string, message: string, readonly failure?: ConnectFailure) {
    super(message);
    this.name = errorName;
  }
}

export interface PortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  start?(): void;
}

type Listener = <E extends keyof Events>(name: E, data: Events[E]) => void;

export class BackendClient {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly port: PortLike) {
    port.addEventListener('message', (e) => this.receive(e.data as Message));
    port.start?.();
  }

  request<M extends Method>(method: M, params: Requests[M]['params']): Promise<Requests[M]['result']> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ kind: 'request', id, method, params } satisfies Message);
    });
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Rejects every request still waiting: the backend process is gone. */
  failPending(reason: string): void {
    for (const p of this.pending.values()) p.reject(new BackendError('BackendExitedError', reason));
    this.pending.clear();
  }

  private receive(message: Message): void {
    if (message.kind === 'event') {
      for (const l of this.listeners) l(message.name, message.data as never);
      return;
    }
    if (message.kind !== 'response') return;
    const p = this.pending.get(message.id);
    if (!p) return;
    this.pending.delete(message.id);
    if (message.ok) p.resolve(message.result);
    else p.reject(new BackendError(message.error.name, message.error.message, message.error.failure));
  }
}
