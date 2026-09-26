/**
 * Schema version 6: two more ways a call ends (phase 07). RELEASED MIGRATIONS
 * ARE NEVER EDITED (D27).
 *
 * - cancelled: the user cancelled it; notifications/cancelled was sent. The
 *   server may still have finished the work.
 * - interrupted: the call was under way when the session ended or the app
 *   stopped. Neither the server's answer nor the user's choice ended it. A
 *   call left in progress by a crash is marked this at the next open
 *   (deferred/phase-02), so retention can purge it.
 *
 * SQLite cannot change a CHECK constraint in place, and `call` is a parent
 * table: dropping it with foreign keys on would cascade into every round,
 * unit and frame. This migration runs with foreign keys off, as SQLite's own
 * table-rebuild procedure requires, and migrate() checks them before it
 * commits.
 */
export const sql = `
CREATE TABLE call_v6 (
  id             INTEGER PRIMARY KEY,
  server_id      TEXT    NOT NULL REFERENCES server (id) ON DELETE CASCADE,
  connection_id  INTEGER REFERENCES connection (id) ON DELETE SET NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('tool', 'prompt', 'resource')),
  target         TEXT    NOT NULL,
  status         TEXT    NOT NULL CHECK (status IN ('in_progress', 'completed', 'error', 'abandoned', 'capped', 'cancelled', 'interrupted')),
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  CHECK ((status = 'in_progress') = (finished_at IS NULL))
) STRICT;
INSERT INTO call_v6 (id, server_id, connection_id, kind, target, status, started_at, finished_at)
  SELECT id, server_id, connection_id, kind, target, status, started_at, finished_at FROM call;
DROP TABLE call;
ALTER TABLE call_v6 RENAME TO call;
CREATE INDEX call_by_server ON call (server_id, started_at);
CREATE INDEX call_by_age ON call (started_at);
`;
