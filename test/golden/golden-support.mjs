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
 * One row in every schema-1 table, exercising the columns a later migration
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
}
