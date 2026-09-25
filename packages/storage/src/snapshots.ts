import {
  canonicalJson,
  diffSurfaces,
  hashPrompt,
  hashResource,
  hashResourceTemplate,
  hashSurface,
  hashTool,
  unavailableFields,
  type CaptureProblem,
  type Era,
  type NormalizedSurface,
  type SurfaceDiff,
} from '../../protocol/dist/index.js';
import { StorageError } from './errors.js';
import type { Workspace } from './workspace-db.js';

/**
 * Surface version history (D8): one snapshot per distinct surface per server,
 * one observation per capture.
 *
 * Hashing is done here with the protocol package's own functions, never taken
 * from the caller: history and diff must agree about what "the same surface"
 * means, and they can only disagree if two implementations exist. The
 * round-trip test holds this: a snapshot loaded back hashes to the hash it was
 * stored under.
 */

export interface RecordedCapture {
  snapshotId: number;
  /** False when this surface was seen before, including a surface that changed and changed back. */
  isNew: boolean;
  contentHash: string;
}

export interface SnapshotSummary {
  snapshotId: number;
  contentHash: string;
  revision: string;
  era: Era;
  serverName?: string;
  serverVersion?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  observations: number;
}

export interface Observation {
  id: number;
  snapshotId: number;
  connectionId: number | null;
  observedAt: number;
  problems: CaptureProblem[];
}

export class SnapshotNotFoundError extends StorageError {}

const ITEM_TABLES = {
  tools: { table: 'snapshot_tool', key: (i: { name: string }) => i.name, hash: hashTool },
  prompts: { table: 'snapshot_prompt', key: (i: { name: string }) => i.name, hash: hashPrompt },
  resources: { table: 'snapshot_resource', key: (i: { uri: string }) => i.uri, hash: hashResource },
  resourceTemplates: { table: 'snapshot_resource_template', key: (i: { uriTemplate: string }) => i.uriTemplate, hash: hashResourceTemplate },
} as const;

type ItemList = keyof typeof ITEM_TABLES;
const LISTS = Object.keys(ITEM_TABLES) as ItemList[];

/** Records one capture: a new snapshot only if this surface has not been seen for this server. */
export function recordCapture(
  ws: Workspace,
  serverId: string,
  surface: NormalizedSurface,
  options: { connectionId?: number; now?: () => number } = {},
): RecordedCapture {
  const contentHash = hashSurface(surface);
  const at = (options.now ?? Date.now)();
  return ws.db.transaction((): RecordedCapture => {
    const existing = ws.db.prepare('SELECT id FROM surface_snapshot WHERE server_id = ? AND content_hash = ?').get(serverId, contentHash) as { id: number } | undefined;
    let snapshotId: number;
    if (existing) {
      snapshotId = existing.id;
    } else {
      snapshotId = Number(ws.db.prepare(`
        INSERT INTO surface_snapshot (server_id, content_hash, revision, era, server_name, server_version, instructions, capabilities_json, first_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(serverId, contentHash, surface.revision, surface.era, surface.serverName ?? null, surface.serverVersion ?? null,
        surface.instructions ?? null, JSON.stringify(canonicalJson(surface.capabilities ?? {})), at).lastInsertRowid);
      for (const list of LISTS) {
        const { table, key, hash } = ITEM_TABLES[list];
        const insert = ws.db.prepare(`INSERT INTO ${table} (snapshot_id, ordinal, key, item_hash, body_json) VALUES (?, ?, ?, ?, ?)`);
        // Ordinal, not key: capture keeps duplicate names and reports them, and
        // a snapshot must hold what the server actually listed.
        (surface[list] as never[]).forEach((item, ordinal) => {
          insert.run(snapshotId, ordinal, (key as (i: never) => string)(item), (hash as (i: never) => string)(item), JSON.stringify(canonicalJson(item)));
        });
      }
    }
    ws.db.prepare('INSERT INTO surface_observation (server_id, snapshot_id, connection_id, observed_at, problems_json) VALUES (?, ?, ?, ?, ?)')
      .run(serverId, snapshotId, options.connectionId ?? null, at, JSON.stringify(surface.problems ?? []));
    return { snapshotId, isNew: !existing, contentHash };
  })();
}

interface SnapshotRow {
  revision: string; era: Era; server_name: string | null; server_version: string | null;
  instructions: string | null; capabilities_json: string;
}

/**
 * The surface a snapshot holds, in the shape capture produces, so the
 * protocol package's diff and hash apply to it unchanged. Problems belong to
 * observations, not snapshots, and are empty here.
 */
export function loadSnapshot(ws: Workspace, snapshotId: number): NormalizedSurface {
  const row = ws.db.prepare('SELECT revision, era, server_name, server_version, instructions, capabilities_json FROM surface_snapshot WHERE id = ?').get(snapshotId) as SnapshotRow | undefined;
  if (!row) throw new SnapshotNotFoundError(`no snapshot ${snapshotId} in this workspace`);
  const items = (list: ItemList) => (ws.db.prepare(`SELECT body_json FROM ${ITEM_TABLES[list].table} WHERE snapshot_id = ? ORDER BY ordinal`).all(snapshotId) as { body_json: string }[])
    .map((r) => JSON.parse(r.body_json));
  const surface: NormalizedSurface = {
    revision: row.revision,
    era: row.era,
    capabilities: JSON.parse(row.capabilities_json),
    tools: items('tools'),
    prompts: items('prompts'),
    resources: items('resources'),
    resourceTemplates: items('resourceTemplates'),
    unavailable: unavailableFields(row.revision),
    problems: [],
  };
  if (row.server_name !== null) surface.serverName = row.server_name;
  if (row.server_version !== null) surface.serverVersion = row.server_version;
  if (row.instructions !== null) surface.instructions = row.instructions;
  return surface;
}

/** One entry per distinct surface, oldest first. */
export function surfaceHistory(ws: Workspace, serverId: string): SnapshotSummary[] {
  const rows = ws.db.prepare(`
    SELECT s.id, s.content_hash, s.revision, s.era, s.server_name, s.server_version, s.first_seen_at,
           max(o.observed_at) AS last_seen_at, count(o.id) AS observations
    FROM surface_snapshot s JOIN surface_observation o ON o.snapshot_id = s.id
    WHERE s.server_id = ?
    GROUP BY s.id
    ORDER BY s.first_seen_at, s.id
  `).all(serverId) as { id: number; content_hash: string; revision: string; era: Era; server_name: string | null; server_version: string | null; first_seen_at: number; last_seen_at: number; observations: number }[];
  return rows.map((r) => ({
    snapshotId: r.id, contentHash: r.content_hash, revision: r.revision, era: r.era,
    ...(r.server_name !== null ? { serverName: r.server_name } : {}),
    ...(r.server_version !== null ? { serverVersion: r.server_version } : {}),
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, observations: r.observations,
  }));
}

/** Every capture of a server, oldest first, with the problems that capture reported. */
export function listObservations(ws: Workspace, serverId: string): Observation[] {
  return (ws.db.prepare('SELECT id, snapshot_id, connection_id, observed_at, problems_json FROM surface_observation WHERE server_id = ? ORDER BY observed_at, id').all(serverId) as
    { id: number; snapshot_id: number; connection_id: number | null; observed_at: number; problems_json: string }[])
    .map((r) => ({ id: r.id, snapshotId: r.snapshot_id, connectionId: r.connection_id, observedAt: r.observed_at, problems: JSON.parse(r.problems_json) }));
}

/** What changed between two stored snapshots, by the protocol package's diff. */
export function diffSnapshots(ws: Workspace, before: number, after: number): SurfaceDiff {
  return diffSurfaces(loadSnapshot(ws, before), loadSnapshot(ws, after));
}

/** A server's most recent capture: what the surface views and the context preview show. */
export interface LatestCapture {
  snapshotId: number;
  observedAt: number;
  connectionId: number | null;
  /** The surface with that capture's problems, which the snapshot alone does not hold. */
  surface: NormalizedSurface;
}

export function latestCapture(ws: Workspace, serverId: string): LatestCapture | undefined {
  const row = ws.db.prepare('SELECT snapshot_id, connection_id, observed_at, problems_json FROM surface_observation WHERE server_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1').get(serverId) as
    { snapshot_id: number; connection_id: number | null; observed_at: number; problems_json: string } | undefined;
  if (!row) return undefined;
  return {
    snapshotId: row.snapshot_id,
    observedAt: row.observed_at,
    connectionId: row.connection_id,
    surface: { ...loadSnapshot(ws, row.snapshot_id), problems: JSON.parse(row.problems_json) },
  };
}
