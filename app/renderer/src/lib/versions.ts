// The version views' pure logic (plan phase 09, board 7): what each history
// row says, the unstable line, the "Compare with" default, and the diff's
// hunk headers, marked spans, field rows and token line.
import type {
  DiffLine, FieldChange, Hunk, SurfaceDiff, TokenDelta, VersionEntry, VersionTimeline,
} from '../../../../packages/backend/dist/index.js';

export interface EntryText {
  /** "Version 2", or "Identity only" for an entry that is not a version. */
  title: string;
  /** What changed against the entry before. */
  detail: string;
  /** "Same as version 1" when the surface went back to an earlier one. */
  sameAs?: string;
  /** Captures in the run: "1 capture", "4 captures". */
  captures: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function versionName(entries: VersionEntry[], index: number): string {
  const e = entries[index]!;
  return e.version === null ? `the identity entry under version ${e.underVersion}` : `version ${e.version}`;
}

export function entryText(entries: VersionEntry[], index: number): EntryText {
  const e = entries[index]!;
  const prev = index > 0 ? entries[index - 1] : undefined;
  let detail: string;
  switch (e.kind) {
    case 'first':
      detail = `First capture, revision ${e.revision}`;
      break;
    case 'identity':
      detail = identityDetail(prev, e);
      break;
    case 'revision':
      detail = `Revision changed, surface identical: ${prev?.revision} to ${e.revision}`;
      break;
    case 'surface':
      detail = e.changes === 0
        ? 'The surface changed in a way the item diff cannot name (a repeated key)'
        : `${plural(e.changes, 'change', 'changes')}${prev && prev.revision !== e.revision ? `, and revision ${prev.revision} to ${e.revision}` : ''}`;
      break;
  }
  return {
    title: e.version === null ? 'Identity only' : `Version ${e.version}`,
    detail,
    ...(e.sameAs !== undefined ? { sameAs: `Same as ${versionName(entries, e.sameAs)}` } : {}),
    captures: plural(e.observations, 'capture', 'captures'),
  };
}

function identityDetail(prev: VersionEntry | undefined, e: VersionEntry): string {
  const parts: string[] = [];
  if (prev?.serverVersion !== e.serverVersion) parts.push(`version ${prev?.serverVersion ?? '(none)'} to ${e.serverVersion ?? '(none)'}`);
  if (prev?.serverName !== e.serverName) parts.push(`name ${prev?.serverName ?? '(none)'} to ${e.serverName ?? '(none)'}`);
  const what = parts.length > 0 ? `: ${parts.join(', ')}` : '';
  return `${parts.some((p) => p.startsWith('version')) ? 'Version changed' : 'Server identity changed'}, surface identical${what}`;
}

/** A span of time in words: "4 minutes", "2 days". */
export function span(ms: number): string {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ms < minute) return plural(Math.max(0, Math.round(ms / 1000)), 'second', 'seconds');
  if (ms < hour) return plural(Math.round(ms / minute), 'minute', 'minutes');
  if (ms < day) return plural(Math.round(ms / hour), 'hour', 'hours');
  return plural(Math.round(ms / day), 'day', 'days');
}

export function unstableLine(timeline: VersionTimeline): string | null {
  const u = timeline.unstable;
  if (!u) return null;
  return `Unstable: the last ${u.entries} captures each produced a different version, over ${span(u.until - u.since)}.`;
}

/** What an entry is compared with when it is opened: the entry before it, or none for the first. */
export function defaultBase(index: number): number | null {
  return index > 0 ? index - 1 : null;
}

export function hunkHeader(h: Hunk): string {
  return `@@ -${h.beforeStart},${h.beforeCount} +${h.afterStart},${h.afterCount} @@`;
}

export interface Segment { text: string; marked: boolean }

/** A line cut at its mark, so the differing span can be shown apart; an empty mark cuts nothing. */
export function segments(line: DiffLine): Segment[] {
  const m = line.mark;
  if (!m || m[0] === m[1]) return [{ text: line.text, marked: false }];
  return [
    { text: line.text.slice(0, m[0]), marked: false },
    { text: line.text.slice(m[0], m[1]), marked: true },
    { text: line.text.slice(m[1]), marked: false },
  ].filter((s) => s.text !== '');
}

export interface FieldRow {
  /** "Tools", "Prompts", "Resources", "Templates", "Instructions", "Capabilities", "Identity", "Revision". */
  group: string;
  /** The item's name, URI or template; empty for a whole-surface row. */
  key: string;
  kind: 'added' | 'removed' | 'changed';
  /** A JSON Pointer inside the item, when the row is one field of a changed item. */
  path?: string;
  before?: string;
  after?: string;
}

const LIST_GROUPS = [['tools', 'Tools'], ['prompts', 'Prompts'], ['resources', 'Resources'], ['resourceTemplates', 'Templates']] as const;

export function formatValue(v: unknown): string | undefined {
  return v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v);
}

function fieldRow(group: string, key: string, f: FieldChange): FieldRow {
  const row: FieldRow = { group, key, kind: f.kind, path: f.path === '' ? '(whole value)' : f.path };
  const before = formatValue(f.before);
  const after = formatValue(f.after);
  if (before !== undefined) row.before = before;
  if (after !== undefined) row.after = after;
  return row;
}

/** The "By item" view: every difference as a row, down to the field (decision 3). */
export function fieldRows(d: SurfaceDiff): FieldRow[] {
  const rows: FieldRow[] = [];
  if (d.revisionChanged) rows.push({ group: 'Revision', key: '', kind: 'changed', before: d.revisionChanged.from, after: d.revisionChanged.to });
  for (const c of d.identityChanged ?? []) {
    const row: FieldRow = { group: 'Identity', key: c.field, kind: 'changed' };
    if (c.from !== undefined) row.before = c.from;
    if (c.to !== undefined) row.after = c.to;
    rows.push(row);
  }
  if (d.instructions) {
    const row: FieldRow = { group: 'Instructions', key: '', kind: d.instructions.before === undefined ? 'added' : d.instructions.after === undefined ? 'removed' : 'changed' };
    if (d.instructions.before !== undefined) row.before = d.instructions.before;
    if (d.instructions.after !== undefined) row.after = d.instructions.after;
    rows.push(row);
  }
  for (const f of d.capabilityChanges ?? []) rows.push(fieldRow('Capabilities', '', f));
  for (const [list, group] of LIST_GROUPS) {
    for (const item of d[list]) {
      if (item.kind !== 'changed' || !item.fields || item.fields.length === 0) rows.push({ group, key: item.key, kind: item.kind });
      else for (const f of item.fields) rows.push(fieldRow(group, item.key, f));
    }
  }
  return rows;
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function tokenLine(t: TokenDelta): string {
  return t.delta === 0
    ? `No token change (${t.after} ${t.tokenizer.id} tokens)`
    : `${signed(t.delta)} tokens (${t.before} to ${t.after}, ${t.tokenizer.id})`;
}

/** One row of the per-tool token table: name, what happened, the signed change. */
export function toolTokenCells(t: TokenDelta['tools'][number]): [string, string, string] {
  return [t.name, t.before === undefined ? `added, ${t.after}` : t.after === undefined ? `removed, was ${t.before}` : `${t.before} to ${t.after}`, signed(t.delta)];
}
