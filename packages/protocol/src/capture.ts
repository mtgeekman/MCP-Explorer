// Capture a server's complete agent-facing surface.
//
// Written against a narrow SurfaceSource rather than the SDK client, so the
// pagination and normalization logic is unit-testable without spawning a
// process. The SDK adapter lives in client.ts and satisfies this interface.
import type {
  Era,
  NormalizedPrompt,
  NormalizedResource,
  NormalizedResourceTemplate,
  NormalizedSurface,
  NormalizedTool,
} from './model.js';
import { unavailableFields } from './model.js';
import type { CaptureProblem } from './model.js';

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface SurfaceSource {
  revision: string;
  era: Era;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  capabilities: unknown;
  /** Absent lister means the server does not advertise that capability. */
  listTools?(cursor?: string): Promise<Page<Record<string, unknown>>>;
  listPrompts?(cursor?: string): Promise<Page<Record<string, unknown>>>;
  listResources?(cursor?: string): Promise<Page<Record<string, unknown>>>;
  listResourceTemplates?(cursor?: string): Promise<Page<Record<string, unknown>>>;
}

export class PaginationError extends Error {}

/** Hard ceiling on pages per list. A capture must terminate. */
export const MAX_PAGES = 1000;

/**
 * Walk every page before returning. A partial capture invents a phantom
 * version, so this refuses to return a truncated list rather than quietly
 * yielding one.
 *
 * Two ways a server can prevent termination, both detected rather than hung on:
 * repeating a cursor it already issued, and simply never stopping.
 */
export async function collectPages<T>(
  list: (cursor?: string) => Promise<Page<T>>,
  what: string,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await list(cursor);
    items.push(...result.items);
    const next = result.nextCursor;
    if (next === undefined) return items;
    if (seen.has(next)) {
      throw new PaginationError(
        `${what}: server repeated pagination cursor ${JSON.stringify(next)} after ${page + 1} page(s); refusing to loop`,
      );
    }
    seen.add(next);
    cursor = next;
  }
  throw new PaginationError(`${what}: exceeded ${MAX_PAGES} pages; refusing to continue`);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function normalizeTool(raw: Record<string, unknown>): NormalizedTool {
  return {
    name: String(raw.name),
    title: str(raw.title),
    description: str(raw.description),
    icons: raw.icons,
    inputSchema: raw.inputSchema,
    outputSchema: raw.outputSchema,
    annotations: raw.annotations,
  };
}

function normalizePrompt(raw: Record<string, unknown>): NormalizedPrompt {
  return {
    name: String(raw.name),
    title: str(raw.title),
    description: str(raw.description),
    icons: raw.icons,
    arguments: raw.arguments,
  };
}

function normalizeResource(raw: Record<string, unknown>): NormalizedResource {
  return {
    uri: String(raw.uri),
    name: str(raw.name),
    title: str(raw.title),
    description: str(raw.description),
    mimeType: str(raw.mimeType),
    icons: raw.icons,
  };
}

function normalizeResourceTemplate(raw: Record<string, unknown>): NormalizedResourceTemplate {
  return {
    uriTemplate: String(raw.uriTemplate),
    name: str(raw.name),
    title: str(raw.title),
    description: str(raw.description),
    mimeType: str(raw.mimeType),
    icons: raw.icons,
  };
}

/**
 * Walk one list, recording a failure rather than aborting the whole capture.
 *
 * A server that advertises a capability and then fails the matching list is a
 * real and common defect -- and revealing it is this app's job, so one broken
 * list must not cost the user every other surface the server does expose.
 *
 * Not silent: the failure lands in `problems`, which the UI shows. It is
 * deliberately NOT hashed -- a transient failure would otherwise read as a
 * surface change and pollute the version history.
 *
 * Only the SERVER's failures are recorded. A TypeError, RangeError,
 * ReferenceError or SyntaxError is a defect in this code by definition, and
 * recording one would blame the server for our bug, drop the list, and move the
 * surface hash -- writing a spurious version into the history. Those propagate.
 */
async function collectOrRecord<T>(
  list: ((cursor?: string) => Promise<Page<T>>) | undefined,
  what: string,
  problems: CaptureProblem[],
): Promise<T[]> {
  if (!list) return [];
  try {
    return await collectPages(list, what);
  } catch (e: unknown) {
    if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError) {
      throw e;
    }
    problems.push({ endpoint: what, kind: 'list-failed', message: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/**
 * Report repeated identity keys.
 *
 * Hashing and diffing are name-keyed, which is deliberate -- it makes a diff a
 * join rather than a tree walk -- but it means a repeated name keeps only the
 * survivor in the per-item hashes and in every diff. A server exposing two
 * tools with one name is broken, because an agent cannot address the second,
 * and revealing that is this app's job.
 *
 * Covers every list that is identity-keyed: tools and prompts by `name`,
 * resources by `uri`, resource templates by `uriTemplate`. It deliberately does
 * NOT look for duplicates across different lists -- a prompt and a tool sharing
 * a name is legal and unremarkable.
 */
function reportDuplicates<T>(
  items: T[],
  key: (item: T) => string,
  endpoint: string,
  problems: CaptureProblem[],
): void {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) duplicated.add(k);
    seen.add(k);
  }
  if (duplicated.size > 0) {
    problems.push({
      endpoint,
      kind: 'duplicate-keys',
      message: `duplicate identity key(s): ${[...duplicated].sort().join(', ')} -- only one of each survives hashing and diffing`,
    });
  }
}

export async function captureSurface(source: SurfaceSource): Promise<NormalizedSurface> {
  const problems: CaptureProblem[] = [];
  const tools = await collectOrRecord(source.listTools?.bind(source), 'tools/list', problems);
  const prompts = await collectOrRecord(source.listPrompts?.bind(source), 'prompts/list', problems);
  const resources = await collectOrRecord(source.listResources?.bind(source), 'resources/list', problems);
  const templates = await collectOrRecord(source.listResourceTemplates?.bind(source), 'resources/templates/list', problems);

  const normalizedTools = tools.map(normalizeTool);
  const normalizedPrompts = prompts.map(normalizePrompt);
  const normalizedResources = resources.map(normalizeResource);
  const normalizedTemplates = templates.map(normalizeResourceTemplate);

  reportDuplicates(normalizedTools, (t) => t.name, 'tools/list', problems);
  reportDuplicates(normalizedPrompts, (p) => p.name, 'prompts/list', problems);
  reportDuplicates(normalizedResources, (r) => r.uri, 'resources/list', problems);
  reportDuplicates(normalizedTemplates, (t) => t.uriTemplate, 'resources/templates/list', problems);

  return {
    revision: source.revision,
    era: source.era,
    serverName: source.serverInfo?.name,
    serverVersion: source.serverInfo?.version,
    instructions: source.instructions,
    capabilities: source.capabilities ?? {},
    tools: normalizedTools,
    prompts: normalizedPrompts,
    resources: normalizedResources,
    resourceTemplates: normalizedTemplates,
    unavailable: unavailableFields(source.revision),
    problems,
  };
}
