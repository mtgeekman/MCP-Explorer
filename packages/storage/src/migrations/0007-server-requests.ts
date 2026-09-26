/**
 * Schema version 7: requests a legacy-era server sends the client (phase 08;
 * spec D23, amended 2026-09-25). RELEASED MIGRATIONS ARE NEVER EDITED (D27).
 *
 * On the legacy era `sampling/createMessage`, `elicitation/create`,
 * `roots/list` and anything else a server asks arrive as server-to-client
 * requests, and the human answers each one. They are recorded here rather
 * than as call rounds because a server may send one outside any call (a
 * `roots/list` right after initialize is common), and because the call's own
 * round is still open while it waits. The frames stay the ground truth; this
 * row says which call it was linked to, what the human answered, and how it
 * ended.
 *
 * - call_id: the call it was linked to, set only when exactly one call was
 *   running on the connection when it arrived. A stdio request carries no
 *   link of its own, so with two calls running it is linked to neither.
 * - status: `answered` (a result went back), `refused` (an error went back),
 *   `cancelled` (the server cancelled it), `interrupted` (the session or the
 *   app ended first).
 * - params_json and response_json are NULL when withheld under the results
 *   opt-out (D30): a sampling request carries conversation content.
 */
export const sql = `
CREATE TABLE server_request (
  id             INTEGER PRIMARY KEY,
  connection_id  INTEGER NOT NULL REFERENCES connection (id) ON DELETE CASCADE,
  call_id        INTEGER REFERENCES call (id) ON DELETE CASCADE,
  jsonrpc_id     TEXT    NOT NULL,
  method         TEXT    NOT NULL,
  params_json    TEXT    CHECK (params_json IS NULL OR json_valid(params_json)),
  status         TEXT    NOT NULL CHECK (status IN ('pending', 'answered', 'refused', 'cancelled', 'interrupted')),
  response_json  TEXT    CHECK (response_json IS NULL OR json_valid(response_json)),
  withheld       INTEGER NOT NULL DEFAULT 0 CHECK (withheld IN (0, 1)),
  -- The wire unit that carried the request, found when it arrived.
  request_unit_id INTEGER REFERENCES wire_unit (id) ON DELETE SET NULL,
  received_at    INTEGER NOT NULL,
  finished_at    INTEGER,
  CHECK ((status = 'pending') = (finished_at IS NULL))
) STRICT;
CREATE INDEX server_request_by_connection ON server_request (connection_id, id);
CREATE INDEX server_request_by_call ON server_request (call_id);
`;
