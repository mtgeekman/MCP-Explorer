import { StorageError } from './errors.js';
import type { Workspace } from './workspace-db.js';

/**
 * A workspace's own settings, one row in `workspace_meta`: the results
 * opt-out (D4, D30), retention (D24), and the two call settings (D7, D21).
 */
export interface WorkspaceSettings {
  persistResults: boolean;
  retentionMaxBytes: number;
  retentionMaxAgeDays: number;
  /** Confirm a call not marked read-only before it runs (D7). Off is the per-workspace bypass. */
  askBeforeCalls: boolean;
  /** MRTR rounds before a call pauses and asks whether to go on (D21). */
  mrtrSoftCap: number;
}

export class InvalidSettingsError extends StorageError {}

export function readSettings(ws: Workspace): WorkspaceSettings {
  const row = ws.db.prepare('SELECT persist_results, retention_max_bytes, retention_max_age_days, ask_before_calls, mrtr_soft_cap FROM workspace_meta WHERE id = 1').get() as
    { persist_results: number; retention_max_bytes: number; retention_max_age_days: number; ask_before_calls: number; mrtr_soft_cap: number };
  return {
    persistResults: row.persist_results === 1,
    retentionMaxBytes: row.retention_max_bytes,
    retentionMaxAgeDays: row.retention_max_age_days,
    askBeforeCalls: row.ask_before_calls === 1,
    mrtrSoftCap: row.mrtr_soft_cap,
  };
}

/**
 * Changes any of the workspace's settings. Applies from the next frame, round,
 * call or purge; nothing already stored is rewritten. Changes arrive from the
 * renderer, so each is checked here rather than trusted to its type.
 */
export function updateSettings(ws: Workspace, changes: Partial<WorkspaceSettings>): WorkspaceSettings {
  const positiveInt = (name: keyof WorkspaceSettings) => {
    const v = changes[name];
    if (v !== undefined && (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0)) throw new InvalidSettingsError(`${name} must be a positive whole number, got ${String(v)}`);
  };
  const flag = (name: keyof WorkspaceSettings) => {
    const v = changes[name];
    if (v !== undefined && typeof v !== 'boolean') throw new InvalidSettingsError(`${name} must be true or false, got ${String(v)}`);
  };
  positiveInt('retentionMaxBytes');
  positiveInt('retentionMaxAgeDays');
  positiveInt('mrtrSoftCap');
  flag('persistResults');
  flag('askBeforeCalls');
  const current = readSettings(ws);
  const next: WorkspaceSettings = {
    persistResults: changes.persistResults ?? current.persistResults,
    retentionMaxBytes: changes.retentionMaxBytes ?? current.retentionMaxBytes,
    retentionMaxAgeDays: changes.retentionMaxAgeDays ?? current.retentionMaxAgeDays,
    askBeforeCalls: changes.askBeforeCalls ?? current.askBeforeCalls,
    mrtrSoftCap: changes.mrtrSoftCap ?? current.mrtrSoftCap,
  };
  ws.db.prepare('UPDATE workspace_meta SET persist_results = ?, retention_max_bytes = ?, retention_max_age_days = ?, ask_before_calls = ?, mrtr_soft_cap = ? WHERE id = 1')
    .run(next.persistResults ? 1 : 0, next.retentionMaxBytes, next.retentionMaxAgeDays, next.askBeforeCalls ? 1 : 0, next.mrtrSoftCap);
  return next;
}
