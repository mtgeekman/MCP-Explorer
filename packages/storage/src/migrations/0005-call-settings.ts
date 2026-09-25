/**
 * Schema version 5: the two call settings the settings screen holds (phase 05).
 * RELEASED MIGRATIONS ARE NEVER EDITED (D27).
 *
 * - ask_before_calls: the per-workspace confirm bypass (D7, board 6.2B). On by
 *   default; off means a call not marked read-only runs without confirming.
 * - mrtr_soft_cap: MRTR rounds a call may take before the app pauses it and
 *   asks whether to go on (D21, spec open item 9). 5 by default.
 */
export const sql = `
ALTER TABLE workspace_meta ADD COLUMN ask_before_calls INTEGER NOT NULL DEFAULT 1 CHECK (ask_before_calls IN (0, 1));
ALTER TABLE workspace_meta ADD COLUMN mrtr_soft_cap INTEGER NOT NULL DEFAULT 5 CHECK (mrtr_soft_cap > 0);
`;
