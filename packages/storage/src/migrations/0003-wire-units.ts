/**
 * Schema version 3: the wire log keeps exact bytes (spec D34). RELEASED
 * MIGRATIONS ARE NEVER EDITED (D27).
 *
 * A wire unit is what crossed the wire or the process boundary as one piece:
 * a stdio line with its line ending, an HTTP body, an SSE event, a stderr
 * line, or an app event such as a spawn or an exit. A frame stays one row per
 * JSON-RPC message, keeping its id, method and call binding, and from this
 * version points at the unit that carried it. A unit that did not parse as
 * JSON-RPC (an HTML page, a banner line) is a unit with no frames.
 *
 * Frames written before this version keep message_json, the SDK's parse
 * re-serialized, and have no unit. SQLite cannot change a CHECK constraint in
 * place, so the frame table is rebuilt with its rows copied as they were.
 */
export const sql = `
CREATE TABLE wire_unit (
  id             INTEGER PRIMARY KEY,
  connection_id  INTEGER NOT NULL REFERENCES connection (id) ON DELETE CASCADE,
  -- Set when every message in the unit belongs to one call, so the unit goes
  -- with the call (D24). A batch spanning calls stays connection-level.
  call_id        INTEGER REFERENCES call (id) ON DELETE CASCADE,
  direction      TEXT    NOT NULL CHECK (direction IN ('out', 'in', 'local')),
  kind           TEXT    NOT NULL CHECK (kind IN ('wire', 'stderr', 'app')),
  at             INTEGER NOT NULL,
  -- The exact bytes. NULL only when withheld under the results opt-out (D30).
  bytes          BLOB,
  -- Kept when the bytes are withheld, so the log can still say how big it was.
  byte_length    INTEGER NOT NULL CHECK (byte_length >= 0),
  withheld       INTEGER NOT NULL DEFAULT 0 CHECK (withheld IN (0, 1)),
  -- HTTP method, URL, status and content type; secret headers never (D35).
  http_json      TEXT    CHECK (http_json IS NULL OR json_valid(http_json)),
  CHECK ((bytes IS NULL) = (withheld = 1)),
  CHECK (bytes IS NULL OR length(bytes) = byte_length),
  CHECK (kind = 'wire' OR withheld = 0),
  CHECK ((direction = 'local') = (kind = 'app'))
) STRICT;
CREATE INDEX wire_unit_by_connection ON wire_unit (connection_id, id);
CREATE INDEX wire_unit_by_call ON wire_unit (call_id);

CREATE TABLE frame_v3 (
  id               INTEGER PRIMARY KEY,
  connection_id    INTEGER NOT NULL REFERENCES connection (id) ON DELETE CASCADE,
  unit_id          INTEGER REFERENCES wire_unit (id) ON DELETE CASCADE,
  call_id          INTEGER,
  round_seq        INTEGER,
  direction        TEXT    NOT NULL CHECK (direction IN ('out', 'in')),
  at               INTEGER NOT NULL,
  jsonrpc_id       TEXT,
  method           TEXT,
  -- Only on frames written before schema 3: the parse, re-serialized.
  message_json     TEXT    CHECK (message_json IS NULL OR json_valid(message_json)),
  -- This message was a result withheld under the opt-out (D30).
  result_withheld  INTEGER NOT NULL DEFAULT 0 CHECK (result_withheld IN (0, 1)),
  CHECK (unit_id IS NULL OR message_json IS NULL),
  CHECK (unit_id IS NOT NULL OR ((message_json IS NULL) = (result_withheld = 1))),
  CHECK ((call_id IS NULL) = (round_seq IS NULL)),
  FOREIGN KEY (call_id, round_seq) REFERENCES call_round (call_id, seq) ON DELETE CASCADE
) STRICT;
INSERT INTO frame_v3 (id, connection_id, unit_id, call_id, round_seq, direction, at, jsonrpc_id, method, message_json, result_withheld)
  SELECT id, connection_id, NULL, call_id, round_seq, direction, at, jsonrpc_id, method, message_json, result_withheld FROM frame;
DROP TABLE frame;
ALTER TABLE frame_v3 RENAME TO frame;
CREATE INDEX frame_by_connection ON frame (connection_id, id);
CREATE INDEX frame_by_round ON frame (call_id, round_seq);
CREATE INDEX frame_by_unit ON frame (unit_id);
`;
