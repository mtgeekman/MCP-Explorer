-- index call_by_age
CREATE INDEX call_by_age ON call (started_at);

-- index call_by_server
CREATE INDEX call_by_server ON call (server_id, started_at);

-- index connection_by_server
CREATE INDEX connection_by_server ON connection (server_id, opened_at);

-- index frame_by_connection
CREATE INDEX frame_by_connection ON frame (connection_id, id);

-- index frame_by_round
CREATE INDEX frame_by_round ON frame (call_id, round_seq);

-- index frame_by_unit
CREATE INDEX frame_by_unit ON frame (unit_id);

-- index server_request_by_call
CREATE INDEX server_request_by_call ON server_request (call_id);

-- index server_request_by_connection
CREATE INDEX server_request_by_connection ON server_request (connection_id, id);

-- index snapshot_prompt_by_key
CREATE INDEX snapshot_prompt_by_key ON snapshot_prompt (snapshot_id, key);

-- index snapshot_resource_by_key
CREATE INDEX snapshot_resource_by_key ON snapshot_resource (snapshot_id, key);

-- index snapshot_resource_template_by_key
CREATE INDEX snapshot_resource_template_by_key ON snapshot_resource_template (snapshot_id, key);

-- index snapshot_tool_by_key
CREATE INDEX snapshot_tool_by_key ON snapshot_tool (snapshot_id, key);

-- index surface_observation_by_server
CREATE INDEX surface_observation_by_server ON surface_observation (server_id, observed_at);

-- index wire_unit_by_call
CREATE INDEX wire_unit_by_call ON wire_unit (call_id);

-- index wire_unit_by_connection
CREATE INDEX wire_unit_by_connection ON wire_unit (connection_id, id);

-- table call
CREATE TABLE "call" ( id INTEGER PRIMARY KEY, server_id TEXT NOT NULL REFERENCES server (id) ON DELETE CASCADE, connection_id INTEGER REFERENCES connection (id) ON DELETE SET NULL, kind TEXT NOT NULL CHECK (kind IN ('tool', 'prompt', 'resource')), target TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'error', 'abandoned', 'capped', 'cancelled', 'interrupted')), started_at INTEGER NOT NULL, finished_at INTEGER, CHECK ((status = 'in_progress') = (finished_at IS NULL)) ) STRICT;

-- table call_round
CREATE TABLE call_round ( call_id INTEGER NOT NULL REFERENCES call (id) ON DELETE CASCADE, seq INTEGER NOT NULL CHECK (seq >= 1), arguments_json TEXT CHECK (arguments_json IS NULL OR json_valid(arguments_json)), -- NULL when the workspace opts out of persisting results (D4, D30). result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)), result_type TEXT, input_requests_json TEXT CHECK (input_requests_json IS NULL OR json_valid(input_requests_json)), input_responses_json TEXT CHECK (input_responses_json IS NULL OR json_valid(input_responses_json)), -- Opaque and echoed byte-exact (D16): never TEXT, never parsed. request_state BLOB, error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)), started_at INTEGER NOT NULL, finished_at INTEGER, PRIMARY KEY (call_id, seq) ) STRICT;

-- table connection
CREATE TABLE connection ( id INTEGER PRIMARY KEY, server_id TEXT NOT NULL REFERENCES server (id) ON DELETE CASCADE, opened_at INTEGER NOT NULL, closed_at INTEGER, negotiated_revision TEXT, era TEXT CHECK (era IS NULL OR era IN ('legacy', 'modern')) ) STRICT;

-- table frame
CREATE TABLE "frame" ( id INTEGER PRIMARY KEY, connection_id INTEGER NOT NULL REFERENCES connection (id) ON DELETE CASCADE, unit_id INTEGER REFERENCES wire_unit (id) ON DELETE CASCADE, call_id INTEGER, round_seq INTEGER, direction TEXT NOT NULL CHECK (direction IN ('out', 'in')), at INTEGER NOT NULL, jsonrpc_id TEXT, method TEXT, -- Only on frames written before schema 3: the parse, re-serialized. message_json TEXT CHECK (message_json IS NULL OR json_valid(message_json)), -- This message was a result withheld under the opt-out (D30). result_withheld INTEGER NOT NULL DEFAULT 0 CHECK (result_withheld IN (0, 1)), CHECK (unit_id IS NULL OR message_json IS NULL), CHECK (unit_id IS NOT NULL OR ((message_json IS NULL) = (result_withheld = 1))), CHECK ((call_id IS NULL) = (round_seq IS NULL)), FOREIGN KEY (call_id, round_seq) REFERENCES call_round (call_id, seq) ON DELETE CASCADE ) STRICT;

-- table server
CREATE TABLE server ( id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL CHECK (transport IN ('stdio', 'streamable-http', 'sse')), command TEXT, args_json TEXT CHECK (args_json IS NULL OR json_valid(args_json)), cwd TEXT, url TEXT, env_json TEXT CHECK (env_json IS NULL OR json_valid(env_json)), -- D20: detected once and persisted; re-probed on -32022. detected_revision TEXT, detected_era TEXT CHECK (detected_era IS NULL OR detected_era IN ('legacy', 'modern')), era_detected_at INTEGER, created_at INTEGER NOT NULL, headers_json TEXT CHECK (headers_json IS NULL OR json_valid(headers_json)), CHECK ((transport = 'stdio') = (command IS NOT NULL)), CHECK ((transport = 'stdio') = (url IS NULL)) ) STRICT;

-- table server_request
CREATE TABLE server_request ( id INTEGER PRIMARY KEY, connection_id INTEGER NOT NULL REFERENCES connection (id) ON DELETE CASCADE, call_id INTEGER REFERENCES call (id) ON DELETE CASCADE, jsonrpc_id TEXT NOT NULL, method TEXT NOT NULL, params_json TEXT CHECK (params_json IS NULL OR json_valid(params_json)), status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'refused', 'cancelled', 'interrupted')), response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)), withheld INTEGER NOT NULL DEFAULT 0 CHECK (withheld IN (0, 1)), -- The wire unit that carried the request, found when it arrived. request_unit_id INTEGER REFERENCES wire_unit (id) ON DELETE SET NULL, received_at INTEGER NOT NULL, finished_at INTEGER, CHECK ((status = 'pending') = (finished_at IS NULL)) ) STRICT;

-- table server_secret
CREATE TABLE server_secret ( server_id TEXT NOT NULL REFERENCES server (id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('env', 'header')), name TEXT NOT NULL CHECK (name <> ''), value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (server_id, kind, name) ) STRICT;

-- table server_secret_name
CREATE TABLE server_secret_name ( server_id TEXT NOT NULL REFERENCES server (id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('env', 'header')), name TEXT NOT NULL CHECK (name <> ''), PRIMARY KEY (server_id, kind, name) ) STRICT;

-- table snapshot_prompt
CREATE TABLE snapshot_prompt ( snapshot_id INTEGER NOT NULL REFERENCES surface_snapshot (id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, key TEXT NOT NULL, item_hash TEXT NOT NULL, body_json TEXT NOT NULL CHECK (json_valid(body_json)), PRIMARY KEY (snapshot_id, ordinal) ) STRICT;

-- table snapshot_resource
CREATE TABLE snapshot_resource ( snapshot_id INTEGER NOT NULL REFERENCES surface_snapshot (id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, key TEXT NOT NULL, item_hash TEXT NOT NULL, body_json TEXT NOT NULL CHECK (json_valid(body_json)), PRIMARY KEY (snapshot_id, ordinal) ) STRICT;

-- table snapshot_resource_template
CREATE TABLE snapshot_resource_template ( snapshot_id INTEGER NOT NULL REFERENCES surface_snapshot (id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, key TEXT NOT NULL, item_hash TEXT NOT NULL, body_json TEXT NOT NULL CHECK (json_valid(body_json)), PRIMARY KEY (snapshot_id, ordinal) ) STRICT;

-- table snapshot_tool
CREATE TABLE snapshot_tool ( snapshot_id INTEGER NOT NULL REFERENCES surface_snapshot (id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, key TEXT NOT NULL, item_hash TEXT NOT NULL, body_json TEXT NOT NULL CHECK (json_valid(body_json)), PRIMARY KEY (snapshot_id, ordinal) ) STRICT;

-- table surface_observation
CREATE TABLE surface_observation ( id INTEGER PRIMARY KEY, server_id TEXT NOT NULL REFERENCES server (id) ON DELETE CASCADE, snapshot_id INTEGER NOT NULL REFERENCES surface_snapshot (id) ON DELETE CASCADE, connection_id INTEGER REFERENCES connection (id) ON DELETE SET NULL, observed_at INTEGER NOT NULL, problems_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(problems_json)) ) STRICT;

-- table surface_snapshot
CREATE TABLE surface_snapshot ( id INTEGER PRIMARY KEY, server_id TEXT NOT NULL REFERENCES server (id) ON DELETE CASCADE, content_hash TEXT NOT NULL, revision TEXT NOT NULL, era TEXT NOT NULL CHECK (era IN ('legacy', 'modern')), server_name TEXT, server_version TEXT, instructions TEXT, capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)), first_seen_at INTEGER NOT NULL, UNIQUE (server_id, content_hash) ) STRICT;

-- table wire_unit
CREATE TABLE wire_unit ( id INTEGER PRIMARY KEY, connection_id INTEGER NOT NULL REFERENCES connection (id) ON DELETE CASCADE, -- Set when every message in the unit belongs to one call, so the unit goes -- with the call (D24). A batch spanning calls stays connection-level. call_id INTEGER REFERENCES call (id) ON DELETE CASCADE, direction TEXT NOT NULL CHECK (direction IN ('out', 'in', 'local')), kind TEXT NOT NULL CHECK (kind IN ('wire', 'stderr', 'app')), at INTEGER NOT NULL, -- The exact bytes. NULL only when withheld under the results opt-out (D30). bytes BLOB, -- Kept when the bytes are withheld, so the log can still say how big it was. byte_length INTEGER NOT NULL CHECK (byte_length >= 0), withheld INTEGER NOT NULL DEFAULT 0 CHECK (withheld IN (0, 1)), -- HTTP method, URL, status and content type; secret headers never (D35). http_json TEXT CHECK (http_json IS NULL OR json_valid(http_json)), CHECK ((bytes IS NULL) = (withheld = 1)), CHECK (bytes IS NULL OR length(bytes) = byte_length), CHECK (kind = 'wire' OR withheld = 0), CHECK ((direction = 'local') = (kind = 'app')) ) STRICT;

-- table workspace_meta
CREATE TABLE workspace_meta ( id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, created_at INTEGER NOT NULL, persist_results INTEGER NOT NULL DEFAULT 1 CHECK (persist_results IN (0, 1)), retention_max_bytes INTEGER NOT NULL DEFAULT 524288000 CHECK (retention_max_bytes > 0), retention_max_age_days INTEGER NOT NULL DEFAULT 90 CHECK (retention_max_age_days > 0) , ask_before_calls INTEGER NOT NULL DEFAULT 1 CHECK (ask_before_calls IN (0, 1)), mrtr_soft_cap INTEGER NOT NULL DEFAULT 5 CHECK (mrtr_soft_cap > 0)) STRICT;
