/**
 * Schema version 2: server secrets inside the workspace database (spec D31),
 * and non-secret HTTP headers beside them. RELEASED MIGRATIONS ARE NEVER
 * EDITED (D27).
 *
 * The database cannot know whether it is encrypted, so "an unencrypted
 * workspace never stores a secret" is enforced where rows are written
 * (servers.ts), not here.
 */
export const sql = `
ALTER TABLE server ADD COLUMN headers_json TEXT CHECK (headers_json IS NULL OR json_valid(headers_json));

CREATE TABLE server_secret (
  server_id   TEXT    NOT NULL REFERENCES server (id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('env', 'header')),
  name        TEXT    NOT NULL CHECK (name <> ''),
  value       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (server_id, kind, name)
) STRICT;
`;
