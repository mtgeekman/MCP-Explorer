// The normalized surface: one shape that spans every protocol revision.
//
// P3 requires that a field absent on the connected revision reads as
// "unavailable on this revision", never as empty -- otherwise an author sees a
// protocol gap and debugs their own server. So the model carries, alongside the
// values, the set of fields the connected revision cannot express.

export type Era = 'legacy' | 'modern';

/**
 * Every revision the pinned SDK can negotiate, oldest first. `2024-10-07` is
 * not a published revision (the spec has no schema or page for it): the SDK
 * accepts it from a server's initialize as a pre-release string and speaks it
 * exactly as 2024-11-05, and its surface is assumed to be 2024-11-05's.
 * test/canonical.test.mjs fails when the SDK adds a revision this lacks.
 */
export const REVISIONS = [
  '2024-10-07',
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
  '2026-07-28',
] as const;
export type Revision = (typeof REVISIONS)[number];

/** Revisions from 2026-07-28 onward use server/discover; earlier ones initialize. */
export const FIRST_MODERN_REVISION: Revision = '2026-07-28';

export function eraOf(revision: string): Era {
  return compareRevisions(revision, FIRST_MODERN_REVISION) >= 0 ? 'modern' : 'legacy';
}

/**
 * Orders two revisions by their dates. A revision the table lacks is placed
 * by its date too: the SDK negotiates revisions this table may not list, and
 * decides the wire era by the same comparison (isModernProtocolVersion,
 * `version >= "2026-07-28"`), so the era here always agrees with the one on
 * the wire. A string that is not a YYYY-MM-DD date is refused, never guessed;
 * the SDK negotiates none.
 */
export function compareRevisions(a: string, b: string): number {
  assertRevision(a);
  assertRevision(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertRevision(revision: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(revision)) throw new RangeError(`not a protocol revision: ${JSON.stringify(revision)}`);
}

/** Position of a revision in the table, which must list it. */
export function revisionIndex(revision: Revision): number {
  const i = (REVISIONS as readonly string[]).indexOf(revision);
  if (i === -1) throw new RangeError(`${revision} is not in the revision table`);
  return i;
}

/**
 * When each surface field became expressible. A field missing from this table
 * has existed since the first published revision, 2024-11-05, and is assumed
 * for 2024-10-07, which has no schema to check.
 *
 * Withdrawals matter as much as additions: `tool.execution` and the core
 * `tasks/*` surface arrived in 2025-11-25 and were REMOVED in 2026-07-28, so
 * `until` is not decoration. Grepping only the newest schema shows what exists,
 * never what was taken away.
 */
export interface FieldWindow {
  since?: Revision;
  until?: Revision;
}

export const FIELD_WINDOWS: Record<string, FieldWindow> = {
  'tool.annotations': { since: '2025-03-26' },
  'tool.title': { since: '2025-06-18' },
  'tool.outputSchema': { since: '2025-06-18' },
  'tool.icons': { since: '2025-11-25' },
  'tool.execution': { since: '2025-11-25', until: '2025-11-25' },
  'prompt.title': { since: '2025-06-18' },
  'prompt.icons': { since: '2025-11-25' },
  'resource.title': { since: '2025-06-18' },
  'resource.icons': { since: '2025-11-25' },
  'resourceTemplate.title': { since: '2025-06-18' },
  'resourceTemplate.icons': { since: '2025-11-25' },
  'capabilities.extensions': { since: '2026-07-28' },
};

/** Fields the given revision cannot express, sorted for stable output. */
export function unavailableFields(revision: string): string[] {
  assertRevision(revision);
  return Object.entries(FIELD_WINDOWS)
    .filter(([, w]) => (w.since !== undefined && compareRevisions(revision, w.since) < 0)
      || (w.until !== undefined && compareRevisions(revision, w.until) > 0))
    .map(([field]) => field)
    .sort();
}

export interface NormalizedTool {
  name: string;
  title?: string;
  description?: string;
  icons?: unknown;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  /** 2025-11-25 only: `taskSupport` and whatever else the server sends there. */
  execution?: unknown;
}

export interface NormalizedPrompt {
  name: string;
  title?: string;
  description?: string;
  icons?: unknown;
  arguments?: unknown;
}

export interface NormalizedResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: unknown;
  /** As sent: a number on every revision, but a server may send anything. */
  size?: unknown;
  annotations?: unknown;
}

export interface NormalizedResourceTemplate {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: unknown;
  annotations?: unknown;
}

/**
 * A list endpoint the server advertised and then failed. Recorded rather than
 * thrown, and never hashed: it is a runtime condition, not surface.
 */
export interface CaptureProblem {
  endpoint: string;
  /**
   * `list-failed`: the list was not read, so the capture is not the whole
   * surface. `duplicate-keys`: it was read and repeats an identity key.
   * `malformed` (phase 10): one entry breaks a rule every revision states.
   * Absent on problems stored before phase 06.
   */
  kind?: 'list-failed' | 'duplicate-keys' | 'malformed';
  /** `malformed`: the entry's identity key as sent, or its position when it has none. */
  key?: string;
  message: string;
}

export interface NormalizedSurface {
  /** The revision actually negotiated, not the newest the server listed. */
  revision: string;
  era: Era;
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  capabilities: unknown;
  tools: NormalizedTool[];
  prompts: NormalizedPrompt[];
  resources: NormalizedResource[];
  resourceTemplates: NormalizedResourceTemplate[];
  /** Fields this revision cannot express. Never conflate with "absent". */
  unavailable: string[];
  /** Endpoints advertised but broken. Shown to the user; never hashed. */
  problems: CaptureProblem[];
}
