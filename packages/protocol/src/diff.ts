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
  hashPrompt,
  hashResource,
  hashResourceTemplate,
  hashTool,
} from './canonical.js';

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface ItemChange {
  key: string;
  kind: ChangeKind;
}

export interface SurfaceDiff {
  identical: boolean;
  /** Present only when the negotiated revision differs. */
  revisionChanged?: { from: string; to: string };
  /** serverInfo differences, kept apart from the surface itself. */
  identityChanged?: { field: 'serverName' | 'serverVersion'; from?: string; to?: string }[];
  instructionsChanged: boolean;
  capabilitiesChanged: boolean;
  tools: ItemChange[];
  prompts: ItemChange[];
  resources: ItemChange[];
  resourceTemplates: ItemChange[];
}

function joinByKey<T>(
  before: T[],
  after: T[],
  key: (item: T) => string,
  hash: (item: T) => string,
): ItemChange[] {
  const a = new Map(before.map((i) => [key(i), hash(i)]));
  const b = new Map(after.map((i) => [key(i), hash(i)]));
  const changes: ItemChange[] = [];

  for (const [k, beforeHash] of a) {
    const afterHash = b.get(k);
    if (afterHash === undefined) changes.push({ key: k, kind: 'removed' });
    else if (afterHash !== beforeHash) changes.push({ key: k, kind: 'changed' });
  }
  for (const k of b.keys()) {
    if (!a.has(k)) changes.push({ key: k, kind: 'added' });
  }
  return changes.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

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
    tools: joinByKey(before.tools, after.tools, (t) => t.name, hashTool),
    prompts: joinByKey(before.prompts, after.prompts, (p) => p.name, hashPrompt),
    resources: joinByKey(before.resources, after.resources, (r) => r.uri, hashResource),
    resourceTemplates: joinByKey(
      before.resourceTemplates,
      after.resourceTemplates,
      (t) => t.uriTemplate,
      hashResourceTemplate,
    ),
  };

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
