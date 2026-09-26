// Shared by scripts/golden-db.mjs (which writes golden files) and
// test/storage-migrations.test.mjs (which checks against them), so the two
// cannot disagree about what "the schema" or "the rows" mean.

/**
 * The schema as a stable text: every table, index, view and trigger SQLite
 * holds, sorted, whitespace-normalized. Internal sqlite_* objects excluded.
 */
export function dumpSchema(db) {
  const rows = db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name",
  ).all();
  return rows.map((r) => `-- ${r.type} ${r.name}\n${r.sql.replace(/\s+/g, ' ').trim()};\n`).join('\n');
}

export function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
}

export function rowCounts(db) {
  return Object.fromEntries(tableNames(db).map((t) => [t, db.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n]));
}

/**
 * One row in every table, exercising the columns a later migration
 * is most likely to touch: nullable JSON, the BLOB, composite keys, the
 * withheld-frame shape. A new migration's golden seed extends this; it never
 * edits what an earlier version seeded.
 */
export function seedEveryTable(db) {
  const t = 1_757_808_000_000;
  db.prepare(`INSERT INTO server (id, name, transport, command, args_json, env_json, detected_revision, detected_era, era_detected_at, created_at)
              VALUES ('srv-1', 'fixture', 'stdio', 'node', '["server.mjs"]', '{"LEVEL":"debug"}', '2026-07-28', 'modern', ?, ?)`).run(t, t);
  db.prepare(`INSERT INTO server (id, name, transport, url, created_at) VALUES ('srv-2', 'remote', 'streamable-http', 'https://example.test/mcp', ?)`).run(t);
  db.prepare(`INSERT INTO connection (id, server_id, opened_at, closed_at, negotiated_revision, era) VALUES (1, 'srv-1', ?, ?, '2026-07-28', 'modern')`).run(t, t + 5000);
  db.prepare(`INSERT INTO surface_snapshot (id, server_id, content_hash, revision, era, server_name, server_version, instructions, capabilities_json, first_seen_at)
              VALUES (1, 'srv-1', 'hash-1', '2026-07-28', 'modern', 'fixture', '1.0.0', 'Use the tools.', '{"tools":{}}', ?)`).run(t);
  for (const [table, key] of [['snapshot_tool', 'echo'], ['snapshot_prompt', 'greet'], ['snapshot_resource', 'file:///a'], ['snapshot_resource_template', 'file:///{path}']]) {
    db.prepare(`INSERT INTO ${table} (snapshot_id, ordinal, key, item_hash, body_json) VALUES (1, 0, ?, 'item-hash', '{"name":"x"}')`).run(key);
  }
  db.prepare(`INSERT INTO surface_observation (server_id, snapshot_id, connection_id, observed_at, problems_json) VALUES ('srv-1', 1, 1, ?, '[]')`).run(t);
  db.prepare(`INSERT INTO call (id, server_id, connection_id, kind, target, status, started_at, finished_at) VALUES (1, 'srv-1', 1, 'tool', 'echo', 'completed', ?, ?)`).run(t, t + 10);
  db.prepare(`INSERT INTO call_round (call_id, seq, arguments_json, result_json, result_type, input_requests_json, input_responses_json, request_state, started_at, finished_at)
              VALUES (1, 1, '{"text":"hi"}', NULL, 'input_required', '{"q":{"method":"elicitation/create"}}', NULL, ?, ?, ?)`).run(Buffer.from([0, 255, 1]), t, t + 5);
  db.prepare(`INSERT INTO call_round (call_id, seq, arguments_json, result_json, result_type, input_responses_json, started_at, finished_at)
              VALUES (1, 2, '{"text":"hi"}', '{"content":[]}', 'complete', '{"q":{"action":"accept"}}', ?, ?)`).run(t + 6, t + 10);
  db.prepare(`INSERT INTO frame (connection_id, call_id, round_seq, direction, at, jsonrpc_id, method, message_json, result_withheld)
              VALUES (1, 1, 1, 'out', ?, '7', 'tools/call', '{"jsonrpc":"2.0","id":7,"method":"tools/call"}', 0)`).run(t);
  db.prepare(`INSERT INTO frame (connection_id, call_id, round_seq, direction, at, jsonrpc_id, method, message_json, result_withheld)
              VALUES (1, 1, 1, 'in', ?, '7', 'tools/call', NULL, 1)`).run(t + 5);
  db.prepare(`INSERT INTO frame (connection_id, direction, at, method, message_json) VALUES (1, 'out', ?, 'server/discover', '{"jsonrpc":"2.0","id":1,"method":"server/discover"}')`).run(t);

  // Schema 2 (server secrets, D31). Golden databases are unencrypted, so this
  // row exists only to exercise the table's shape; the app never writes a
  // secret to an unencrypted workspace.
  if (tableNames(db).includes('server_secret')) {
    db.prepare(`UPDATE server SET headers_json = '{"Accept":"application/json"}' WHERE id = 'srv-2'`).run();
    db.prepare(`INSERT INTO server_secret (server_id, kind, name, value, updated_at) VALUES ('srv-2', 'header', 'Authorization', 'golden-not-a-secret', ?)`).run(t);
  }

  // Schema 3 (wire units, D34): a call-bound unit with its frame, a withheld
  // unit, a unit that is not JSON-RPC, a stderr line, an app event, and HTTP
  // details.
  if (tableNames(db).includes('wire_unit')) {
    const unit = db.prepare(`INSERT INTO wire_unit (id, connection_id, call_id, direction, kind, at, bytes, byte_length, withheld, http_json)
                             VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const bytes = (text) => Buffer.from(text, 'utf8');
    const call = '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"echo"}}\r\n';
    unit.run(1, 1, 'out', 'wire', t + 6, bytes(call), Buffer.byteLength(call), 0, null);
    unit.run(2, 1, 'in', 'wire', t + 7, null, 57, 1, '{"status":200,"contentType":"application/json"}');
    unit.run(3, null, 'in', 'wire', t + 8, bytes('<html></html>'), 13, 0, '{"status":502,"contentType":"text/html"}');
    unit.run(4, null, 'in', 'stderr', t + 8, bytes('listening\n'), 10, 0, null);
    unit.run(5, null, 'local', 'app', t + 9, bytes('{"event":"exited","code":0}'), 27, 0, null);
    const frame = db.prepare(`INSERT INTO frame (connection_id, unit_id, call_id, round_seq, direction, at, jsonrpc_id, method, result_withheld)
                              VALUES (1, ?, 1, 2, ?, ?, '8', 'tools/call', ?)`);
    frame.run(1, 'out', t + 6, 0);
    frame.run(2, 'in', t + 7, 1);
  }

  // Schema 4 (secret names, D31 amended): a secret the app asks for each session.
  if (tableNames(db).includes('server_secret_name')) {
    db.prepare(`INSERT INTO server_secret_name (server_id, kind, name) VALUES ('srv-1', 'env', 'API_KEY')`).run();
  }

  // Schema 7 (server requests, D23 amended): one answered and linked to a
  // call, one withheld and outside any call, one the app never answered.
  if (tableNames(db).includes('server_request')) {
    const request = db.prepare(`INSERT INTO server_request (connection_id, call_id, jsonrpc_id, method, params_json, status, response_json, withheld, request_unit_id, received_at, finished_at)
                                VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    request.run(1, '0', 'sampling/createMessage', '{"messages":[],"maxTokens":10}', 'answered', '{"role":"assistant","content":{"type":"text","text":"hi"},"model":"human"}', 0, 1, t + 6, t + 7);
    request.run(null, '"srv-1"', 'roots/list', null, 'refused', null, 1, null, t + 8, t + 9);
    request.run(null, '2', 'elicitation/create', '{"message":"?"}', 'interrupted', null, 0, null, t + 8, t + 9);
  }
}
