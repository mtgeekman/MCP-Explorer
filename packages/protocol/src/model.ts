// The normalized surface: one shape that spans every protocol revision.
//
// P3 requires that a field absent on the connected revision reads as
// "unavailable on this revision", never as empty -- otherwise an author sees a
// protocol gap and debugs their own server. So the model carries, alongside the
// values, the set of fields the connected revision cannot express.

export type Era = 'legacy' | 'modern';

export const REVISIONS = [
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
  return revisionIndex(revision) >= revisionIndex(FIRST_MODERN_REVISION) ? 'modern' : 'legacy';
}

/**
 * Position of a revision in the published order. Unknown revisions sort AFTER
 * every known one: a revision we have never heard of is newer than the ones we
 * have, and treating it as oldest would silently downgrade every feature check.
 */
export function revisionIndex(revision: string): number {
  const i = (REVISIONS as readonly string[]).indexOf(revision);
  return i === -1 ? REVISIONS.length : i;
}

/**
 * When each surface field became expressible. A field missing from this table
 * has existed since the first revision.
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
  const at = revisionIndex(revision);
  return Object.entries(FIELD_WINDOWS)
    .filter(([, w]) => (w.since !== undefined && at < revisionIndex(w.since))
      || (w.until !== undefined && at > revisionIndex(w.until)))
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
}

export interface NormalizedResourceTemplate {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  icons?: unknown;
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
   * Absent on problems stored before phase 06.
   */
  kind?: 'list-failed' | 'duplicate-keys';
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
