// The messages between the renderer and the backend (D32). Deliberately not
// JSON-RPC: no module outside the transport layer constructs a JSON-RPC
// message (P1), and these are the app's own, not protocol traffic.
import type { ConnectFailure, HttpDetails } from '../../protocol/dist/index.js';
import type { PurgeResult, ServerSummary, Transport, WorkspaceSettings } from '../../storage/dist/index.js';

export type { PurgeResult, WorkspaceSettings, ConfigLocation, FoundLocation, ImportChoice, ReadConfig };
import type { ConnectionState, SecretValues } from './connections.js';
import type { Protection, Unlock, WorkspaceListing, WorkspaceNotice } from './workspaces.js';
import type { ConfigLocation } from '../../platform/dist/index.js';
import type { FoundLocation, ImportChoice, ReadConfig } from './importer.js';

/**
 * A server definition as the renderer sees and edits it. Secret values never
 * cross to the renderer once stored: a stored secret is listed by name, and
 * saving with `null` for its value keeps what is stored.
 */
export interface ServerForm {
  id?: string;
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** A value to store, or null to keep the stored one. Encrypted workspaces only (D31). */
  secretEnv?: Record<string, string | null>;
  secretHeaders?: Record<string, string | null>;
  /** Secrets asked for each session instead of stored (D31, amended). */
  unstoredSecrets?: { env?: string[]; headers?: string[] };
}

export interface ServerRow extends ServerSummary {
  state: ConnectionState;
  /** The pinned era, when one is (D20). */
  era?: { era: 'legacy' | 'modern'; revision: string | null };
}

export interface OpenedWorkspace {
  id: string;
  name: string;
  encrypted: boolean;
  /** Present once, when a keychain workspace is created: to be copied, never saved to a file. */
  recoveryKey?: string;
}

/** A wire unit as the log lists it. Bytes travel as they are; a large one is still whole (board 4.2B). */
export interface LogUnit {
  id: number;
  serverId: string;
  connectionId: number;
  direction: 'out' | 'in' | 'local';
  kind: 'wire' | 'stderr' | 'app';
  at: number;
  byteLength: number;
  /** Null when withheld under the results opt-out (D30). */
  bytes: Uint8Array | null;
  http?: HttpDetails;
  /** The JSON-RPC messages the unit carried, in order: none for stderr, app events and bytes that are not JSON-RPC. */
  frames: LogFrame[];
  /** Frames written before schema 3 have no unit; they are listed from their re-serialized message and say so (D34). */
  reserialized?: boolean;
}

/** A message within a unit, as the log indexed it: the id keeps its type (7 is "7", "7" is "\"7\""). */
export interface LogFrame {
  jsonrpcId: string | null;
  method: string | null;
  /** A result withheld under the opt-out (D30). */
  resultWithheld: boolean;
}

/** Where a page of the log ends: units and re-serialized frames are ordered together by time. */
export interface LogCursor {
  at: number;
  id: number;
  reserialized: boolean;
}

/** Every request the backend answers, by method name. */
export interface Requests {
  'workspaces.list': { params: Record<string, never>; result: WorkspaceListing[] };
  'workspaces.current': { params: Record<string, never>; result: OpenedWorkspace | null };
  'workspaces.create': { params: { name: string; protection: Protection }; result: OpenedWorkspace };
  'workspaces.open': { params: { id: string; unlock: Unlock }; result: OpenedWorkspace };
  'workspaces.close': { params: Record<string, never>; result: null };
  'servers.list': { params: Record<string, never>; result: ServerRow[] };
  'servers.get': { params: { id: string }; result: ServerForm };
  'servers.save': { params: { server: ServerForm }; result: ServerRow };
  'servers.delete': { params: { id: string }; result: boolean };
  'connections.connect': { params: { serverId: string; secrets?: SecretValues }; result: ConnectionState };
  'connections.startAgain': { params: { serverId: string }; result: ConnectionState };
  'connections.redetect': { params: { serverId: string }; result: ConnectionState };
  'connections.disconnect': { params: { serverId: string }; result: ConnectionState };
  /** A page of a server's log, newest last, older than `before` when given. */
  'log.units': { params: { serverId: string; before?: LogCursor; limit?: number }; result: LogUnit[] };
  /** One unit, for a window showing a selection it did not load (the popped-out pane, board 1A). */
  'log.get': { params: { id: number; reserialized?: boolean }; result: LogUnit | null };
  'settings.get': { params: Record<string, never>; result: WorkspaceSettings };
  /** Applies from the next frame, call or purge; nothing already stored changes (D24, D30). */
  'settings.update': { params: { changes: Partial<WorkspaceSettings> }; result: WorkspaceSettings };
  'history.size': { params: Record<string, never>; result: HistorySize };
  /** What a purge would delete now, deleting nothing: shown before "Purge now" (D24). */
  'history.previewPurge': { params: Record<string, never>; result: PurgeResult };
  'history.purge': { params: Record<string, never>; result: PurgeResult };
  /** VACUUM: an explicit user command, never automatic (D24). */
  'history.compact': { params: Record<string, never>; result: { before: number; after: number } };
  /** Which known config files exist, the user's and those of chosen project folders; nothing is read (decision 1). */
  'import.locations': { params: { projectRoots?: string[] }; result: FoundLocation[] };
  /** Reads and parses the files the user picked. */
  'import.read': { params: { locations: ConfigLocation[] }; result: ReadConfig[] };
  /** Saves the servers the user kept, all or none. Nothing is started. */
  'import.save': { params: { servers: ImportChoice[] }; result: ServerRow[] };
}

/** The workspace file against the retention cap: the file can be larger than the cap until compacted (D24). */
export interface HistorySize {
  /** Pages in the file times page size. */
  fileBytes: number;
  /** Pages in use: an upper bound on live bytes, which is what the cap measures. */
  usedBytes: number;
}

export type Method = keyof Requests;

/** Everything the backend tells the renderer without being asked. */
export interface Events {
  'connection.state': { serverId: string; state: ConnectionState };
  'log.unit': LogUnit;
  notice: WorkspaceNotice;
}

export type Message =
  | { kind: 'request'; id: number; method: Method; params: unknown }
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: ErrorReply }
  | { kind: 'event'; name: keyof Events; data: unknown };

/** An error as it crosses to the renderer: its class name decides what the UI offers. */
export interface ErrorReply {
  name: string;
  message: string;
  failure?: ConnectFailure;
}
