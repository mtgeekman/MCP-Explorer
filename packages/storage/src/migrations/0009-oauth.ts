/**
 * Schema version 9: OAuth (plan phase 11 decisions 6 and 7). RELEASED
 * MIGRATIONS ARE NEVER EDITED (D27).
 *
 * `server_oauth_client` is a client the user registered with an authorization
 * server by hand and typed in: part of the server's definition, rewritten
 * with it. Its secret, when it has one, is a secret (D31): only an encrypted
 * workspace stores it.
 *
 * `server_oauth` is what a sign-in produced: one row per server and issuer
 * (2026-07-28 keeps registrations per authorization server), holding the
 * client as registered and the tokens. Written only in an encrypted
 * workspace; an unencrypted one keeps it in memory for the session. It is
 * not part of the definition, so editing a server does not sign it out.
 */
export const sql = `
CREATE TABLE server_oauth_client (
  server_id     TEXT NOT NULL PRIMARY KEY REFERENCES server (id) ON DELETE CASCADE,
  client_id     TEXT NOT NULL CHECK (client_id <> ''),
  redirect_uri  TEXT NOT NULL,
  client_secret TEXT
) STRICT;

CREATE TABLE server_oauth (
  server_id    TEXT    NOT NULL REFERENCES server (id) ON DELETE CASCADE,
  issuer       TEXT    NOT NULL,
  auth_server  TEXT    NOT NULL,
  resource     TEXT,
  client_json  TEXT    NOT NULL CHECK (json_valid(client_json)),
  tokens_json  TEXT    CHECK (tokens_json IS NULL OR json_valid(tokens_json)),
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (server_id, issuer)
) STRICT;
`;
