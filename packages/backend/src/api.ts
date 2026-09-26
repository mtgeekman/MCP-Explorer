// The messages between the renderer and the backend (D32). Deliberately not
// JSON-RPC: no module outside the transport layer constructs a JSON-RPC
// message (P1), and these are the app's own, not protocol traffic.
import type { ConnectFailure, ContextCost, HttpDetails, NormalizedSurface, Verdict, CallProgress, VersionComparison, TextComparison, TokenDelta, ToolTokenDelta, SurfaceDiff, ItemChange, FieldChange, TextDiff, Hunk, DiffLine } from '../../protocol/dist/index.js';
import type { CallRecord, CallSummary, PurgeResult, RoundRecord, ServerSummary, Transport, WorkspaceSettings, VersionTimeline, VersionEntry, VersionKind } from '../../storage/dist/index.js';
import type { AwaitedInput, CallChange, CallExport, CallStart, CallView, ConfirmPrompt, LiveCall, LiveTask, StartReply, TaskOp } from './calls.js';
import type { ServerRequestRow } from './server-requests.js';
import type { CallOutcome, ServerAnswer, LogLevel, SubscriptionFilter, UtilityMethod, UtilityOutcome, ListenEnd } from '../../protocol/dist/index.js';
import type { SessionInfo, ListenView } from './session-controls.js';
import type { NotificationRow } from './notifications.js';
import type { HealthReport, ListState } from './health.js';
import type { AuthReport } from './auth.js';
import type { AuthChallenge, AuthFailure } from '../../protocol/dist/index.js';

export type { PurgeResult, WorkspaceSettings, ConfigLocation, FoundLocation, ImportChoice, ReadConfig };
export type { CallExport, CallStart, CallView, ConfirmPrompt, LiveCall, StartReply, CallRecord, CallSummary, RoundRecord, Verdict, CallProgress };
export type { AwaitedInput, ServerRequestRow, ServerAnswer, LiveTask, TaskOp };
export type { HealthReport, ListState };
export type { AuthReport, AuthChallenge, AuthFailure };
export type { LogLevel, SubscriptionFilter, UtilityMethod, UtilityOutcome, ListenEnd, SessionInfo, ListenView, NotificationRow };
export type { VersionTimeline, VersionEntry, VersionKind, VersionComparison, TextComparison, TokenDelta, ToolTokenDelta, SurfaceDiff, ItemChange, FieldChange, TextDiff, Hunk, DiffLine };
import type { CaptureStatus, ConnectionState, PartialCapture, SecretValues } from './connections.js';
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
  /**
   * A client registered by hand (phase 11 decision 6). `clientSecret` is
   * like a stored secret: null keeps the stored one, and it is never sent back.
   */
  oauthClient?: { clientId: string; redirectUri: string; clientSecret?: string | null };
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
  /** Null when withheld under the results opt-out (D30), or when omitted from a list (see `omitted`). */
  bytes: Uint8Array | null;
  /**
   * The bytes were left out of this message because the unit is larger than
   * LIST_BYTES_LIMIT; log.get has them whole. `head` is their start, for the
   * row's preview (phase 07 decision 9).
   */
  omitted?: { head: Uint8Array };
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

/** A server's latest stored surface and where this session's capture stands. */
export interface SurfaceView {
  capture: {
    snapshotId: number;
    observedAt: number;
    /** Null for a capture recorded outside a connection. */
    connectionId: number | null;
    surface: NormalizedSurface;
  } | null;
  status: CaptureStatus;
  /** This session's newest capture when one of its lists failed: newer than `capture`, shown, never recorded (R06-11). */
  partial: PartialCapture | null;
}

/** A list of a server's surface whose entries have their own detail view. */
export type EntryList = 'tools' | 'prompts' | 'resources' | 'resourceTemplates';

/** One entry's exact bytes from the reply it was listed in (board 5.1A), or why they cannot be shown. */
export type RawEntry =
  | { found: true; bytes: Uint8Array; unitId: number; offset: number }
  | { found: false; reason: string };

/** A server as the context preview lists it, and how old its surface is. Which are left out is the caller's own list. */
export interface ContextServerRow {
  id: string;
  name: string;
  /** When its latest surface was captured; null when it has none, so it adds nothing. */
  capturedAt: number | null;
  revision?: string;
}

/** The workspace union (D3; phase 06 decisions 2 and 4). */
export interface ContextView {
  servers: ContextServerRow[];
  /** The block as the preview shows it. */
  text: string;
  cost: ContextCost;
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
  'surface.get': { params: { serverId: string }; result: SurfaceView };
  /** Lists the connected server's surface again and records it; resolves once done (decision 3). */
  'surface.refresh': { params: { serverId: string }; result: SurfaceView };
  /** The exact bytes of one entry of the latest capture, keyed by name, uri or uriTemplate. */
  'surface.entry': { params: { serverId: string; list: EntryList; key: string }; result: RawEntry };
  /** Every server's latest surface, less the ones excluded, as one block with its cost. */
  'context.get': { params: { excluded?: string[] }; result: ContextView };
  /** A server's version history, oldest first (phase 09 decisions 1, 2 and 7). */
  'versions.list': { params: { serverId: string }; result: VersionTimeline };
  /** Two of a server's snapshots compared every way the version view shows (decisions 3 to 6). */
  'versions.diff': { params: { serverId: string; before: number; after: number }; result: VersionComparison };
  /**
   * Starts a tool call, prompt get or resource read, or answers with the
   * confirm to show first (D7). Resolves once sent; `call.changed` follows.
   */
  'calls.start': { params: CallStart; result: StartReply };
  /** Cancel a running call: the era's cancellation goes out; the server may still finish. */
  'calls.cancel': { params: { callId: number }; result: null };
  /** End a call waiting for input without answering it: `capped` at the soft cap, `abandoned` elsewhere. */
  'calls.stop': { params: { callId: number }; result: null };
  /**
   * "Send answers and retry" (board 6.3): the answers under the server's keys,
   * every key answered; none for a requestState-only result. Resolves once the
   * retry is on its way; `call.changed` follows.
   */
  'calls.answer': { params: { callId: number; inputResponses?: Record<string, unknown> }; result: null };
  /** A task call: ask for its status, or on legacy its result; one request, one round (phase 10 decision 2). */
  'calls.task': { params: { callId: number; op: TaskOp }; result: null };
  /** Legacy: every task the server holds (tasks/list), sent once. */
  'session.tasks': { params: { serverId: string; cursor?: string }; result: CallOutcome };
  /** "Keep answering" at the soft cap (D21, board 6.4). */
  'calls.continue': { params: { callId: number }; result: null };
  /** A server's requests to the client, newest first (legacy era; phase 08 decision 5). */
  'requests.list': { params: { serverId: string; limit?: number }; result: ServerRequestRow[] };
  /** The person's answer to one: a result, or a refusal with the error they chose. */
  'requests.answer': { params: { requestId: number; answer: ServerAnswer }; result: null };
  /** A server's calls, newest first, with this session's live state. */
  'calls.list': { params: { serverId: string; before?: number; limit?: number }; result: CallListRow[] };
  'calls.get': { params: { callId: number }; result: CallView | null };
  /** A value against a JSON Schema, by the SDK's Ajv (decision 4). Advisory. */
  'calls.validate': { params: { schema: unknown; value: unknown }; result: Verdict };
  /** A call's first request as it was sent, and a curl command for an HTTP server (decision 8). */
  'calls.export': { params: { callId: number }; result: CallExport };
  /** What the user set on the live session: log level, subscriptions, the listen stream (phase 10). */
  'session.get': { params: { serverId: string }; result: SessionInfo };
  /** Legacy: sends logging/setLevel. Modern: held for every later request's _meta, and nothing is sent (decision 5). */
  'session.setLogLevel': { params: { serverId: string; level: LogLevel | null }; result: UtilityOutcome | null };
  /** One utility request, sent once: ping, completion/complete (decisions 3 and 8). */
  'session.request': { params: { serverId: string; method: 'ping' | 'completion/complete'; params?: Record<string, unknown> }; result: UtilityOutcome };
  /** Subscribe or unsubscribe a resource: legacy resources/subscribe, modern the listen's filter (decision 7). */
  'session.subscribe': { params: { serverId: string; uri: string; on: boolean }; result: UtilityOutcome | null };
  /** Modern: open the listen with this filter, replacing an open one; null closes it. */
  'session.listen': { params: { serverId: string; filter: SubscriptionFilter | null }; result: null };
  /**
   * The health check (phase 10 decision 12): connects if needed, lists
   * everything, pings a legacy server, and reports. Shown, never stored.
   */
  'health.check': { params: { serverId: string }; result: HealthReport };
  /** Phase 11: what the app holds for a server's sign-in, never a token value (decision 12). */
  'auth.get': { params: { serverId: string }; result: AuthReport };
  /**
   * Sign in (decision 5): discovery, the client, the authorization URL for
   * the page to open on the user's word. The code is exchanged when the
   * browser comes back; auth.changed says when.
   */
  'auth.signIn': { params: { serverId: string; challenge?: AuthChallenge; scope?: string; reregister?: boolean }; result: { authorizationUrl: string } };
  'auth.cancel': { params: { serverId: string }; result: null };
  /** Forgets the tokens; with `registrations`, the app's registrations too. */
  'auth.signOut': { params: { serverId: string; registrations?: boolean }; result: AuthReport };
  /** "Refresh and retry" (decision 2): one refresh, now. */
  'auth.refresh': { params: { serverId: string }; result: AuthReport };
  /** A page of the server's notifications, oldest first, from units older than `before` (decision 6). */
  'notifications.list': { params: { serverId: string; before?: number; limit?: number }; result: NotificationRow[] };
  /** A resource template's variables, or the URI they make. */
  'resources.template': { params: { uriTemplate: string; values?: Record<string, string> }; result: { variables: string[]; uri?: string } };
}

export type CallListRow = CallSummary & { live?: LiveCall };

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
  /** A capture started or finished, or the server said a list changed: read surface.get again. */
  'surface.changed': { serverId: string };
  /** A call started, reported progress, or ended: read calls.get again. */
  'call.changed': { serverId: string; callId: number; reason: CallChange };
  /** A server's request arrived or ended: list requests again, and the linked call's transcript. */
  'request.changed': { serverId: string; requestId: number; callId: number | null };
  /** What the user set on a live session changed, or the session ended: read session.get again. */
  'session.changed': { serverId: string };
  /** A sign-in started, finished or failed, or tokens were refreshed or forgotten: read auth.get again. */
  'auth.changed': { serverId: string };
  /** Retention deleted history: an open log or call list reloads (R05-9). */
  'log.purged': Record<string, never>;
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
