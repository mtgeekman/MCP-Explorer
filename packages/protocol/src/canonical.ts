// Canonicalization and hashing of a captured surface.
//
// The rule is an ALLOWLIST, not a denylist: hash the fields known to be
// surface and ignore everything else. 2026-07-28 made `ttlMs` and `cacheScope`
// required on every list result, and both are server-chosen per response --
// hash them and every connect looks like a change. A denylist would work until
// the next revision adds another volatile field and would then fail silently,
// producing a new "version" on every connect. An allowlist fails the other way:
// a genuinely new surface field is invisible until someone adds it here, which
// is a missing feature rather than a corrupted history.
import { createHash } from 'node:crypto';
import type {
  NormalizedPrompt,
  NormalizedResource,
  NormalizedResourceTemplate,
  NormalizedSurface,
  NormalizedTool,
} from './model.js';

/** Recursively sort object keys so a server's key order cannot change the hash. */
export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, canonicalJson(v)]));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
}

// One allowlist per item kind. Adding a field here changes every stored hash,
// so it is a deliberate act, not a convenience.
export const TOOL_FIELDS = ['name', 'title', 'description', 'icons', 'inputSchema', 'outputSchema', 'annotations'] as const;
export const PROMPT_FIELDS = ['name', 'title', 'description', 'icons', 'arguments'] as const;
export const RESOURCE_FIELDS = ['uri', 'name', 'title', 'description', 'mimeType', 'icons'] as const;
export const TEMPLATE_FIELDS = ['uriTemplate', 'name', 'title', 'description', 'mimeType', 'icons'] as const;

/** The allowlisted fields of an item: what is hashed, and what a field-level diff compares. */
export function pick<T extends object>(item: T, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = (item as Record<string, unknown>)[f];
    if (v !== undefined) out[f] = v;
  }
  return out;
}

export function hashTool(tool: NormalizedTool): string { return sha256(pick(tool, TOOL_FIELDS)); }
export function hashPrompt(p: NormalizedPrompt): string { return sha256(pick(p, PROMPT_FIELDS)); }
export function hashResource(r: NormalizedResource): string { return sha256(pick(r, RESOURCE_FIELDS)); }
export function hashResourceTemplate(t: NormalizedResourceTemplate): string { return sha256(pick(t, TEMPLATE_FIELDS)); }

const byName = <T>(items: T[], key: (item: T) => string): T[] =>
  [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/**
 * The canonical form of a whole surface: the allowlisted fields only, lists
 * sorted by their identity field, keys sorted throughout.
 *
 * `unavailable` is NOT included -- it is derived from `revision`, which is,
 * so hashing both would double-count one fact.
 */
export function canonicalSurface(s: NormalizedSurface): unknown {
  return canonicalJson({
    revision: s.revision,
    serverName: s.serverName,
    serverVersion: s.serverVersion,
    instructions: s.instructions,
    capabilities: s.capabilities,
    tools: byName(s.tools, (t) => t.name).map((t) => pick(t, TOOL_FIELDS)),
    prompts: byName(s.prompts, (p) => p.name).map((p) => pick(p, PROMPT_FIELDS)),
    resources: byName(s.resources, (r) => r.uri).map((r) => pick(r, RESOURCE_FIELDS)),
    resourceTemplates: byName(s.resourceTemplates, (t) => t.uriTemplate).map((t) => pick(t, TEMPLATE_FIELDS)),
  });
}

export function hashSurface(s: NormalizedSurface): string {
  return sha256(canonicalSurface(s));
}

export interface HashedSurface {
  contentHash: string;
  tools: Map<string, string>;
  prompts: Map<string, string>;
  resources: Map<string, string>;
  resourceTemplates: Map<string, string>;
}

/** Whole-surface hash plus a per-item hash, so a diff is a join, not a tree walk. */
export function hashAll(s: NormalizedSurface): HashedSurface {
  return {
    contentHash: hashSurface(s),
    tools: new Map(s.tools.map((t) => [t.name, hashTool(t)])),
    prompts: new Map(s.prompts.map((p) => [p.name, hashPrompt(p)])),
    resources: new Map(s.resources.map((r) => [r.uri, hashResource(r)])),
    resourceTemplates: new Map(s.resourceTemplates.map((t) => [t.uriTemplate, hashResourceTemplate(t)])),
  };
}
