/**
 * Schema version 4: secrets a server needs whose values are not stored (spec
 * D31, amended 2026-09-24). RELEASED MIGRATIONS ARE NEVER EDITED (D27).
 *
 * An unencrypted workspace cannot hold a secret's value, so it holds only the
 * secret's kind and name, and the app asks for the value each session. A name
 * is not a secret. A secret whose value is stored stays in server_secret alone.
 */
export const sql = `
CREATE TABLE server_secret_name (
  server_id  TEXT NOT NULL REFERENCES server (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('env', 'header')),
  name       TEXT NOT NULL CHECK (name <> ''),
  PRIMARY KEY (server_id, kind, name)
) STRICT;
`;
