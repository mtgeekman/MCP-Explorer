// Diff two captured surfaces.
//
// Name-keyed and hash-compared, so added/removed/changed fall out of a join
// rather than a tree walk -- and deliberately NOT keyed on which server a
// snapshot came from, so pointing this at two different servers later is a
// selection change rather than a feature.
//
// Identity and revision changes are reported separately from surface changes.
// A server that upgrades its protocol revision genuinely changed what an agent
// receives, but reporting that as fifty changed tools buries the signal.
import type { NormalizedSurface } from './model.js';
import {
  canonicalJson,
  hashPrompt,
  hashResource,
  hashResourceTemplate,
  hashTool,
  pick,
  PROMPT_FIELDS,
  RESOURCE_FIELDS,
  TEMPLATE_FIELDS,
  TOOL_FIELDS,
} from './canonical.js';

export type ChangeKind = 'added' | 'removed' | 'changed';

/**
 * One difference inside a value, at a JSON Pointer (RFC 6901) from the item's
 * root: `/description`, `/inputSchema/properties/text/type`. `added` has only
 * `after`, `removed` only `before`.
 */
export interface FieldChange {
  path: string;
  kind: ChangeKind;
  before?: unknown;
  after?: unknown;
}

export interface ItemChange {
  key: string;
  kind: ChangeKind;
  /** On a changed item: where its allowlisted fields differ (phase 09 decision 3). */
  fields?: FieldChange[];
}

export interface SurfaceDiff {
  identical: boolean;
  /** Present only when the negotiated revision differs. */
  revisionChanged?: { from: string; to: string };
  /** serverInfo differences, kept apart from the surface itself. */
  identityChanged?: { field: 'serverName' | 'serverVersion'; from?: string; to?: string }[];
  instructionsChanged: boolean;
  /** The text before and after, present when it changed; absent text is undefined. */
  instructions?: { before?: string; after?: string };
  capabilitiesChanged: boolean;
  /** Where the capabilities differ, present when they changed. */
  capabilityChanges?: FieldChange[];
  tools: ItemChange[];
  prompts: ItemChange[];
  resources: ItemChange[];
  resourceTemplates: ItemChange[];
}

const escapePointer = (segment: string): string => segment.replace(/~/g, '~0').replace(/\//g, '~1');

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Every place two JSON values differ, as JSON Pointers, in key order. Objects
 * are compared key by key and arrays index by index, so a reordered array
 * reads as changed positions: an array's order is part of its value (a
 * schema's `enum`, a prompt's `arguments`), and the hash counts it too.
 */
export function diffJson(before: unknown, after: unknown): FieldChange[] {
  return walk(canonicalJson(before), canonicalJson(after), '');
}

function walk(a: unknown, b: unknown, path: string): FieldChange[] {
  if (a === undefined && b === undefined) return [];
  if (a === undefined) return [{ path, kind: 'added', after: b }];
  if (b === undefined) return [{ path, kind: 'removed', before: a }];
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => walk(a[k], b[k], `${path}/${escapePointer(k)}`));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: FieldChange[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      out.push(...walk(i < a.length ? a[i] : undefined, i < b.length ? b[i] : undefined, `${path}/${i}`));
    }
    return out;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, kind: 'changed', before: a, after: b }];
}

function joinByKey<T extends object>(
  before: T[],
  after: T[],
  key: (item: T) => string,
  hash: (item: T) => string,
  fields: readonly string[],
): ItemChange[] {
  const a = new Map(before.map((i) => [key(i), i]));
  const b = new Map(after.map((i) => [key(i), i]));
  const changes: ItemChange[] = [];

  for (const [k, beforeItem] of a) {
    const afterItem = b.get(k);
    if (afterItem === undefined) changes.push({ key: k, kind: 'removed' });
    else if (hash(afterItem) !== hash(beforeItem)) {
      changes.push({ key: k, kind: 'changed', fields: diffJson(pick(beforeItem, fields), pick(afterItem, fields)) });
    }
  }
  for (const k of b.keys()) {
    if (!a.has(k)) changes.push({ key: k, kind: 'added' });
  }
  return changes.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/**
 * Compare by VALUE, not by serialization order.
 *
 * `JSON.stringify` is key-order sensitive and the hash is not, so a raw
 * comparison here made the diff contradict the version history: identical
 * surfaces hashed the same while the diff reported a capability change. Object
 * key order is not guaranteed by the protocol -- the project's own modern
 * fixture shuffles it on purpose -- so this must canonicalize first, exactly as
 * hashSurface does.
 */
const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonicalJson(a ?? null)) === JSON.stringify(canonicalJson(b ?? null));

export function diffSurfaces(before: NormalizedSurface, after: NormalizedSurface): SurfaceDiff {
  const identity: NonNullable<SurfaceDiff['identityChanged']> = [];
  if (before.serverName !== after.serverName) {
    identity.push({ field: 'serverName', from: before.serverName, to: after.serverName });
  }
  if (before.serverVersion !== after.serverVersion) {
    identity.push({ field: 'serverVersion', from: before.serverVersion, to: after.serverVersion });
  }

  const diff: SurfaceDiff = {
    identical: false,
    instructionsChanged: before.instructions !== after.instructions,
    capabilitiesChanged: !sameJson(before.capabilities, after.capabilities),
    tools: joinByKey(before.tools, after.tools, (t) => t.name, hashTool, TOOL_FIELDS),
    prompts: joinByKey(before.prompts, after.prompts, (p) => p.name, hashPrompt, PROMPT_FIELDS),
    resources: joinByKey(before.resources, after.resources, (r) => r.uri, hashResource, RESOURCE_FIELDS),
    resourceTemplates: joinByKey(
      before.resourceTemplates,
      after.resourceTemplates,
      (t) => t.uriTemplate,
      hashResourceTemplate,
      TEMPLATE_FIELDS,
    ),
  };
  if (diff.instructionsChanged) {
    diff.instructions = {};
    if (before.instructions !== undefined) diff.instructions.before = before.instructions;
    if (after.instructions !== undefined) diff.instructions.after = after.instructions;
  }
  if (diff.capabilitiesChanged) diff.capabilityChanges = diffJson(before.capabilities ?? null, after.capabilities ?? null);

  if (before.revision !== after.revision) {
    diff.revisionChanged = { from: before.revision, to: after.revision };
  }
  if (identity.length > 0) diff.identityChanged = identity;

  diff.identical =
    diff.revisionChanged === undefined &&
    diff.identityChanged === undefined &&
    !diff.instructionsChanged &&
    !diff.capabilitiesChanged &&
    diff.tools.length === 0 &&
    diff.prompts.length === 0 &&
    diff.resources.length === 0 &&
    diff.resourceTemplates.length === 0;

  return diff;
}

/** Total surface-level changes, excluding identity and revision. */
export function surfaceChangeCount(diff: SurfaceDiff): number {
  return diff.tools.length + diff.prompts.length + diff.resources.length + diff.resourceTemplates.length
    + (diff.instructionsChanged ? 1 : 0) + (diff.capabilitiesChanged ? 1 : 0);
}
