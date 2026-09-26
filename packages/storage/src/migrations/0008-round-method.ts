/**
 * Schema version 8: a round's own method (phase 10 decision 2). RELEASED
 * MIGRATIONS ARE NEVER EDITED (D27).
 *
 * A call run as a task is still one call (D23): the tools/call that started
 * it is its first round, and each request the user sends about the task
 * afterwards (tasks/get, tasks/result, tasks/update, tasks/cancel) is a
 * further round. `method` says which. NULL means the call's own method, as
 * every round before this migration was.
 */
export const sql = `
ALTER TABLE call_round ADD COLUMN method TEXT;
`;
