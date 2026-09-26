import type { CallKind, CallStatus } from './history.js';
import type { Workspace } from './workspace-db.js';

/**
 * Reading calls back (D23): the history list, one call with its rounds, and
 * the wire units each round sent and received, so a transcript can open on
 * the exact bytes (D10, D34). Also the one repair a crash leaves behind.
 */

export interface CallSummary {
  id: number;
  serverId: string;
  connectionId: number | null;
  kind: CallKind;
  target: string;
  status: CallStatus | 'in_progress';
  startedAt: number;
  finishedAt: number | null;
  rounds: number;
}

export interface RoundRecord {
  seq: number;
  /** Null when the round was recorded with no arguments. */
  arguments: unknown;
  /** Null when withheld under the results opt-out (D30), or when the round ended without one. */
  result: unknown;
  resultType: string | null;
  inputRequests: unknown;
  inputResponses: unknown;
  /** Opaque bytes, as stored (D16); present only so a transcript can show them. Never replayed (D23). */
  requestState: Uint8Array | null;
  error: unknown;
  startedAt: number;
  finishedAt: number | null;
  /** The unit that carried this round's request, when it reached the wire. */
  requestUnitId: number | null;
  /** The unit that carried the response, when one came and is still stored. */
  responseUnitId: number | null;
  /** The response was withheld under the results opt-out (D30). */
  resultWithheld: boolean;
}

export interface CallRecord extends CallSummary {
  rounds: number;
  roundRecords: RoundRecord[];
}

interface CallRow {
  id: number; server_id: string; connection_id: number | null; kind: CallKind; target: string;
  status: CallSummary['status']; started_at: number; finished_at: number | null; rounds: number;
}

const summary = (r: CallRow): CallSummary => ({
  id: r.id, serverId: r.server_id, connectionId: r.connection_id, kind: r.kind, target: r.target,
  status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, rounds: r.rounds,
});

const SELECT_CALL = `
  SELECT c.id, c.server_id, c.connection_id, c.kind, c.target, c.status, c.started_at, c.finished_at,
         (SELECT count(*) FROM call_round r WHERE r.call_id = c.id) AS rounds
  FROM call c`;

/** A server's calls, newest first; `before` is a call id, for the next page. */
export function listCalls(ws: Workspace, serverId: string, opts: { before?: number; limit?: number } = {}): CallSummary[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const rows = (opts.before === undefined
    ? ws.db.prepare(`${SELECT_CALL} WHERE c.server_id = ? ORDER BY c.id DESC LIMIT ?`).all(serverId, limit)
    : ws.db.prepare(`${SELECT_CALL} WHERE c.server_id = ? AND c.id < ? ORDER BY c.id DESC LIMIT ?`).all(serverId, opts.before, limit)) as CallRow[];
  return rows.map(summary);
}

const parse = (text: string | null): unknown => (text === null ? null : JSON.parse(text));

/** One call and its rounds in order, or undefined when there is no such call (or it was purged). */
export function readCall(ws: Workspace, callId: number): CallRecord | undefined {
  const row = ws.db.prepare(`${SELECT_CALL} WHERE c.id = ?`).get(callId) as CallRow | undefined;
  if (!row) return undefined;
  const rounds = ws.db.prepare(`
    SELECT seq, arguments_json, result_json, result_type, input_requests_json, input_responses_json, request_state, error_json, started_at, finished_at,
      (SELECT f.unit_id FROM frame f WHERE f.call_id = r.call_id AND f.round_seq = r.seq AND f.direction = 'out' ORDER BY f.id LIMIT 1) AS request_unit,
      (SELECT f.unit_id FROM frame f WHERE f.call_id = r.call_id AND f.round_seq = r.seq AND f.direction = 'in' ORDER BY f.id LIMIT 1) AS response_unit,
      (SELECT f.result_withheld FROM frame f WHERE f.call_id = r.call_id AND f.round_seq = r.seq AND f.direction = 'in' ORDER BY f.id LIMIT 1) AS withheld
    FROM call_round r WHERE r.call_id = ? ORDER BY seq
  `).all(callId) as {
    seq: number; arguments_json: string | null; result_json: string | null; result_type: string | null; input_requests_json: string | null;
    input_responses_json: string | null; request_state: Buffer | null; error_json: string | null; started_at: number; finished_at: number | null;
    request_unit: number | null; response_unit: number | null; withheld: number | null;
  }[];
  return {
    ...summary(row),
    roundRecords: rounds.map((r) => ({
      seq: r.seq,
      arguments: parse(r.arguments_json),
      result: parse(r.result_json),
      resultType: r.result_type,
      inputRequests: parse(r.input_requests_json),
      inputResponses: parse(r.input_responses_json),
      requestState: r.request_state === null ? null : new Uint8Array(r.request_state),
      error: parse(r.error_json),
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      requestUnitId: r.request_unit,
      responseUnitId: r.response_unit,
      resultWithheld: r.withheld === 1,
    })),
  };
}

/**
 * What a crash leaves behind, repaired at workspace open (deferred/phase-02):
 * a call still in progress becomes `interrupted`, finished when its last unit
 * was recorded; a connection never closed is closed at its last unit. Before
 * this, retention could never purge either.
 *
 * Safe only because one process opens a workspace at a time: a second process
 * with the same workspace open would have its live calls marked here.
 */
export function repairInterrupted(ws: Workspace): { calls: number; connections: number } {
  return ws.db.transaction(() => {
    const lastCallUnit = `coalesce((SELECT max(u.at) FROM wire_unit u WHERE u.call_id = call.id), started_at)`;
    ws.db.prepare(`
      UPDATE call_round SET finished_at = coalesce((SELECT max(u.at) FROM wire_unit u WHERE u.call_id = call_round.call_id), started_at)
      WHERE finished_at IS NULL AND call_id IN (SELECT id FROM call WHERE status = 'in_progress')
    `).run();
    const calls = ws.db.prepare(`UPDATE call SET status = 'interrupted', finished_at = ${lastCallUnit} WHERE status = 'in_progress'`).run().changes;
    const connections = ws.db.prepare(`
      UPDATE connection SET closed_at = coalesce((SELECT max(u.at) FROM wire_unit u WHERE u.connection_id = connection.id), opened_at)
      WHERE closed_at IS NULL
    `).run().changes;
    return { calls, connections };
  })();
}
