// What the surface views say about a captured surface (round 5, board 5.4).
// Pure, so node:test covers it without a DOM. Four states never collapse into
// each other: a list not advertised, a list that came back empty, an optional
// field the server omitted, and a field the connected revision cannot carry.
import type { EntryList } from '../../../../packages/backend/dist/index.js';
import type { NormalizedSurface } from '../../../../packages/protocol/dist/model.js';
import { FIELD_WINDOWS, REVISIONS, revisionIndex } from '../../../../packages/protocol/dist/model.js';

/** Board 5.1A: every annotations view carries this line. Annotations are never a security boundary. */
export const ANNOTATIONS_LINE = 'Hints the server declares about itself. The app does not trust them: any tool not marked read-only asks before it runs.';

export const LISTS: { list: EntryList; label: string; key: 'name' | 'uri' | 'uriTemplate'; endpoint: string; capability: string }[] = [
  { list: 'tools', label: 'Tools', key: 'name', endpoint: 'tools/list', capability: 'tools' },
  { list: 'prompts', label: 'Prompts', key: 'name', endpoint: 'prompts/list', capability: 'prompts' },
  { list: 'resources', label: 'Resources', key: 'uri', endpoint: 'resources/list', capability: 'resources' },
  { list: 'resourceTemplates', label: 'Templates', key: 'uriTemplate', endpoint: 'resources/templates/list', capability: 'resources' },
];

export type ListState =
  /** The capability is missing, so nothing was asked. */
  | { kind: 'not-advertised' }
  /** Advertised, and the list failed; nothing was recorded for it. */
  | { kind: 'failed'; message: string }
  /** Asked, and it came back empty. */
  | { kind: 'empty' }
  | { kind: 'items'; count: number };

export function listState(surface: NormalizedSurface, list: EntryList): ListState {
  const spec = LISTS.find((l) => l.list === list)!;
  const caps = (surface.capabilities ?? {}) as Record<string, unknown>;
  if (caps[spec.capability] === undefined) return { kind: 'not-advertised' };
  // A duplicate-name problem is reported on the same endpoint but the list
  // itself was read. Problems stored before phase 06 carry no kind; for those
  // the message is all there is (R06-12).
  const failure = surface.problems.find((p) => p.endpoint === spec.endpoint
    && (p.kind ? p.kind === 'list-failed' : !p.message.startsWith('duplicate identity key')));
  if (failure) return { kind: 'failed', message: failure.message };
  const count = (surface[list] as unknown[]).length;
  return count === 0 ? { kind: 'empty' } : { kind: 'items', count };
}

/** The tab label: "Tools 3", "Tools 0", "Tools: not advertised", "Tools: failed". */
export function listLabel(label: string, state: ListState): string {
  switch (state.kind) {
    case 'items': return `${label} ${state.count}`;
    case 'empty': return `${label} 0`;
    case 'not-advertised': return `${label}: not advertised`;
    case 'failed': return `${label}: failed`;
  }
}

export type ItemKind = 'tool' | 'prompt' | 'resource' | 'resourceTemplate';

export const ITEM_KIND: Record<EntryList, ItemKind> = {
  tools: 'tool', prompts: 'prompt', resources: 'resource', resourceTemplates: 'resourceTemplate',
};

/** The optional fields each kind's Fields table shows, in order. Only fields the app captures. */
export const FIELDS: Record<ItemKind, string[]> = {
  tool: ['title', 'description', 'icons', 'inputSchema', 'outputSchema', 'annotations', 'execution'],
  prompt: ['title', 'description', 'icons', 'arguments'],
  resource: ['name', 'title', 'description', 'mimeType', 'icons', 'size', 'annotations'],
  resourceTemplate: ['name', 'title', 'description', 'mimeType', 'icons', 'annotations'],
};

export type FieldState =
  | { kind: 'value'; value: unknown }
  /** Optional, and the server omitted it. */
  | { kind: 'none-sent' }
  /** The connected revision cannot carry it (P3): never "empty". */
  | { kind: 'not-on-revision'; label: string };

export function fieldState(kind: ItemKind, field: string, item: Record<string, unknown>, revision: string): FieldState {
  const window = FIELD_WINDOWS[`${kind}.${field}`];
  if (window) {
    const at = revisionIndex(revision);
    if (window.since !== undefined && at < revisionIndex(window.since)) {
      return { kind: 'not-on-revision', label: `not on ${revision} (added in ${window.since})` };
    }
    if (window.until !== undefined && at > revisionIndex(window.until)) {
      const removedIn = REVISIONS[revisionIndex(window.until) + 1];
      return { kind: 'not-on-revision', label: `not on ${revision} (removed in ${removedIn})` };
    }
  }
  const value = item[field];
  return value === undefined ? { kind: 'none-sent' } : { kind: 'value', value };
}

export interface Param {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

/**
 * A tool's parameters as a person reads them, from its inputSchema. Undefined
 * when the schema has no `properties` object: the raw view is then the only
 * honest rendering, and the pane says so.
 */
export function parameters(schema: unknown): Param[] | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = schema as { properties?: unknown; required?: unknown };
  if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) return undefined;
  const required = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === 'string') : [];
  return Object.entries(s.properties as Record<string, unknown>).map(([name, p]) => {
    const prop = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    return {
      name,
      type: typeOf(prop),
      required: required.includes(name),
      ...(typeof prop.description === 'string' ? { description: prop.description } : {}),
    };
  });
}

function typeOf(prop: Record<string, unknown>): string {
  if (typeof prop.type === 'string') return Array.isArray(prop.enum) ? `${prop.type}, one of ${prop.enum.length}` : prop.type;
  if (Array.isArray(prop.type)) return prop.type.filter((t) => typeof t === 'string').join(' | ');
  for (const k of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(prop[k])) return `${k} (${(prop[k] as unknown[]).length})`;
  }
  if (Array.isArray(prop.enum)) return `one of ${prop.enum.length}`;
  if (typeof prop.$ref === 'string') return prop.$ref;
  return 'any';
}

export interface PromptArgument {
  name: string;
  required: boolean;
  description?: string;
}

/** A prompt's arguments; undefined when the server sent something that is not a list of named arguments. */
export function promptArguments(args: unknown): PromptArgument[] | undefined {
  if (args === undefined) return [];
  if (!Array.isArray(args)) return undefined;
  const out: PromptArgument[] = [];
  for (const a of args) {
    if (!a || typeof a !== 'object' || typeof (a as { name?: unknown }).name !== 'string') return undefined;
    const arg = a as { name: string; required?: unknown; description?: unknown };
    out.push({ name: arg.name, required: arg.required === true, ...(typeof arg.description === 'string' ? { description: arg.description } : {}) });
  }
  return out;
}

/** An annotation object's entries as the pane lists them, values as JSON. */
export function annotationRows(annotations: unknown): [string, string][] | undefined {
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) return undefined;
  return Object.entries(annotations as Record<string, unknown>).map(([k, v]) => [k, JSON.stringify(v)]);
}

/** The key an entry is addressed by in its list. */
export function entryKey(list: EntryList, item: Record<string, unknown>): string {
  return String(item[LISTS.find((l) => l.list === list)!.key]);
}

/** An entry chosen in a surface view, with the definition it was chosen from. */
export interface Selection {
  serverId: string;
  list: EntryList;
  key: string;
  item: Record<string, unknown>;
  revision: string;
}

/**
 * The selection re-read from a newer capture: the pane must show the same
 * definition the raw view fetches, not the one clicked before a Refresh
 * (R06-4). Null when the entry is no longer listed.
 */
export function reselect(selected: Selection, surface: Pick<NormalizedSurface, 'revision' | EntryList> | undefined): Selection | null {
  const item = (surface?.[selected.list] as unknown as Record<string, unknown>[] | undefined)?.find((i) => entryKey(selected.list, i) === selected.key);
  if (!surface || !item) return null;
  // The same selection when nothing changed, so a reload does not re-render the app (R06-15).
  if (surface.revision === selected.revision && JSON.stringify(item) === JSON.stringify(selected.item)) return selected;
  return { ...selected, item, revision: surface.revision };
}
