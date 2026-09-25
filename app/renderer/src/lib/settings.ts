// The settings screen's text fields and what it says about history size and a
// purge. DOM-free, so test/renderer-lib.test.mjs imports it directly.
import type { PurgeResult, WorkspaceSettings } from '../../../../packages/backend/dist/index.js';

export const MB = 1024 * 1024;

export interface SettingsFields {
  askBeforeCalls: boolean;
  mrtrSoftCap: string;
  persistResults: boolean;
  retentionMaxMb: string;
  retentionMaxAgeDays: string;
}

export function toFields(s: WorkspaceSettings): SettingsFields {
  return {
    askBeforeCalls: s.askBeforeCalls,
    mrtrSoftCap: String(s.mrtrSoftCap),
    persistResults: s.persistResults,
    // A cap set outside the screen need not be whole megabytes; show it rounded up.
    retentionMaxMb: String(Math.ceil(s.retentionMaxBytes / MB)),
    retentionMaxAgeDays: String(s.retentionMaxAgeDays),
  };
}

/**
 * The changes the fields make to `current`, or the problems that stop a save.
 * Only fields that differ are sent, so an unchanged size cap that is not a
 * whole number of megabytes is left exactly as it is.
 */
export function parseFields(f: SettingsFields, current: WorkspaceSettings): { changes: Partial<WorkspaceSettings>; problems: string[] } {
  const problems: string[] = [];
  const whole = (text: string, what: string): number | undefined => {
    const t = text.trim();
    if (!/^\d+$/.test(t) || Number(t) <= 0 || !Number.isSafeInteger(Number(t))) {
      problems.push(`${what} must be a whole number above zero.`);
      return undefined;
    }
    return Number(t);
  };
  const changes: Partial<WorkspaceSettings> = {};
  const cap = whole(f.mrtrSoftCap, 'Rounds before pausing');
  const mb = whole(f.retentionMaxMb, 'Largest history');
  const days = whole(f.retentionMaxAgeDays, 'Oldest history');
  if (f.askBeforeCalls !== current.askBeforeCalls) changes.askBeforeCalls = f.askBeforeCalls;
  if (f.persistResults !== current.persistResults) changes.persistResults = f.persistResults;
  if (cap !== undefined && cap !== current.mrtrSoftCap) changes.mrtrSoftCap = cap;
  if (mb !== undefined && mb !== Math.ceil(current.retentionMaxBytes / MB)) {
    if (!Number.isSafeInteger(mb * MB)) problems.push('Largest history is too large.');
    else changes.retentionMaxBytes = mb * MB;
  }
  if (days !== undefined && days !== current.retentionMaxAgeDays) changes.retentionMaxAgeDays = days;
  return { changes, problems };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / (1024 * MB)).toFixed(2)} GB`;
}

/** What a purge (or its preview) deletes, as the sentences the screen shows. Empty when nothing. */
export function describePurge(r: PurgeResult): string[] {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const lines: string[] = [];
  if (r.callsDeleted) lines.push(n(r.callsDeleted, 'call, with its rounds and frames', 'calls, with their rounds and frames'));
  if (r.unitsDeleted) lines.push(`${n(r.unitsDeleted, 'connection-level log entry', 'connection-level log entries')}`);
  if (r.framesDeleted) lines.push(`${n(r.framesDeleted, 'frame recorded before exact capture', 'frames recorded before exact capture')}`);
  if (r.connectionsDeleted) lines.push(`${n(r.connectionsDeleted, 'closed connection record', 'closed connection records')}`);
  return lines;
}
