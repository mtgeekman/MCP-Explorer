// The SDK adapter: connect to a server with the P1 seam intact and the era
// resolved, then expose it as a SurfaceSource the capture layer can walk.
//
// Everything protocol-shaped lives here so the rest of the package stays
// testable without spawning anything.
import type { Era } from './model.js';
import { eraOf } from './model.js';
import type { Page, SurfaceSource } from './capture.js';

/**
 * Subclassing StdioClientTransport is what opts out of the SDK's disposable
 * sibling probe (D20). readStdioServerParams() treats a transport as spawnable
 * only when its IMMEDIATE prototype has an own `_dispose`; a subclass shifts
 * that prototype, so negotiation runs over the already-open process. Without
 * it, one frame per connection travels over a transport we never constructed
 * and is invisible to P1's logger, and every stdio server is spawned twice.
 *
 * This depends on an SDK internal. It is a deliberate escape hatch, not an
 * accident, but it is unversioned -- test/seam.test.mjs is what detects an
 * upgrade closing it. Never relax that assertion to make an upgrade pass.
 */
export type FrameDirection = 'out' | 'in';
export type FrameListener = (direction: FrameDirection, frame: unknown) => void;

export interface ConnectOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  clientName?: string;
  clientVersion?: string;
  /** P1: receives every JSON-RPC frame, negotiation included. */
  onFrame?: FrameListener;
  /** Era-probe timeout. See PROBE_TIMEOUT_MS for why the default is not the SDK's. */
  probeTimeoutMs?: number;
}

/**
 * How long to wait for an era probe before concluding legacy.
 *
 * The SDK inherits its standard request timeout here, which is 60 seconds. On
 * stdio a silent server is a legacy verdict, so that is 60 seconds of nothing
 * on the FIRST connect to any server that ignores `server/discover` -- measured,
 * not guessed: the silent-probe test took 60,015 ms before this was set.
 *
 * A local process that intends to answer a single frame answers it in
 * milliseconds, so 5 seconds is generous. D20 persists the era, so even when
 * this is paid it is paid once per server rather than once per connect.
 *
 * A default, not a pillar. The cost of being wrong is asymmetric by transport:
 * on stdio a too-short timeout mislabels a slow server as legacy, and the user
 * can re-detect; on HTTP the SDK rejects the connect instead of falling back,
 * which is louder and self-correcting.
 */
export const PROBE_TIMEOUT_MS = 5000;

export interface Connection {
  era: Era;
  revision: string;
  source: SurfaceSource;
  close(): Promise<void>;
}

// D21: declaring these is what permits a server to ask for them at all. A
// server MUST NOT send an input request for a capability the client did not
// declare, so this list decides what the app can be asked to do.
const CLIENT_CAPABILITIES = { sampling: {}, elicitation: {}, roots: {} };

function tap(inner: any, onFrame?: FrameListener): any {
  if (!onFrame) return inner;
  return new Proxy(inner, {
    get(t: any, p: string | symbol, r: unknown) {
      if (p === 'send') {
        return async (m: unknown, o?: unknown) => {
          for (const f of Array.isArray(m) ? m : [m]) onFrame('out', f);
          return t.send(m, o);
        };
      }
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t: any, p: string | symbol, v: unknown) {
      if (p === 'onmessage') {
        t.onmessage = (m: unknown, x: unknown) => { onFrame('in', m); (v as any)?.(m, x); };
        return true;
      }
      return Reflect.set(t, p, v);
    },
  });
}

/** A list endpoint the server does not advertise is absent, not an error. */
function lister(
  client: any,
  method: 'listTools' | 'listPrompts' | 'listResources' | 'listResourceTemplates',
  field: 'tools' | 'prompts' | 'resources' | 'resourceTemplates',
  supported: boolean,
): ((cursor?: string) => Promise<Page<Record<string, unknown>>>) | undefined {
  if (!supported) return undefined;
  return async (cursor?: string) => {
    const result = await client[method](cursor === undefined ? {} : { cursor });
    return { items: (result?.[field] ?? []) as Record<string, unknown>[], nextCursor: result?.nextCursor };
  };
}

/** Everything after the transport is connected is identical across transports. */
async function describe(client: any): Promise<Connection> {
  const revision: string = client.getNegotiatedProtocolVersion?.() ?? '2025-06-18';
  const capabilities = client.getServerCapabilities?.() ?? {};
  const caps = capabilities as Record<string, unknown>;

  const source: SurfaceSource = {
    revision,
    era: eraOf(revision),
    serverInfo: client.getServerVersion?.(),
    instructions: client.getInstructions?.(),
    capabilities,
    listTools: lister(client, 'listTools', 'tools', caps.tools !== undefined),
    listPrompts: lister(client, 'listPrompts', 'prompts', caps.prompts !== undefined),
    listResources: lister(client, 'listResources', 'resources', caps.resources !== undefined),
    listResourceTemplates: lister(client, 'listResourceTemplates', 'resourceTemplates', caps.resources !== undefined),
  };
  return { era: source.era, revision, source, close: () => client.close() };
}

export type HttpTransportKind = 'streamable-http' | 'sse';

export interface HttpConnectOptions {
  url: string;
  /** SSE is the transport deprecated in 2025-03-26 and still deployed. */
  kind?: HttpTransportKind;
  clientName?: string;
  clientVersion?: string;
  onFrame?: FrameListener;
  probeTimeoutMs?: number;
}

export async function connectHttp(opts: HttpConnectOptions): Promise<Connection> {
  const mod: any = await import('@modelcontextprotocol/client');
  const Transport = opts.kind === 'sse' ? mod.SSEClientTransport : mod.StreamableHTTPClientTransport;
  const client = new mod.Client(
    { name: opts.clientName ?? 'mcp-explorer', version: opts.clientVersion ?? '0.0.0' },
    {
      versionNegotiation: { mode: 'auto', probe: { timeoutMs: opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS } },
      capabilities: CLIENT_CAPABILITIES,
    },
  );
  // No sibling-probe problem here: only the stdio transport spawns anything.
  // The tap is still required, or negotiation traffic bypasses P1's logger.
  await client.connect(tap(new Transport(new URL(opts.url)), opts.onFrame));
  return describe(client);
}

export async function connectStdio(opts: ConnectOptions): Promise<Connection> {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const Base = StdioClientTransport as unknown as new (o: unknown) => any;
  class SeamStdioTransport extends Base {}

  const transportOptions = {
    command: opts.command,
    args: opts.args ?? [],
    env: opts.env ?? (process.env as Record<string, string>),
    stderr: 'pipe' as const,
  };
  const info = { name: opts.clientName ?? 'mcp-explorer', version: opts.clientVersion ?? '0.0.0' };

  let client = new (Client as any)(info, {
    versionNegotiation: { mode: 'auto', probe: { timeoutMs: opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS } },
    capabilities: CLIENT_CAPABILITIES,
  });

  try {
    await client.connect(tap(new SeamStdioTransport(transportOptions), opts.onFrame));
  } catch (e: unknown) {
    // D20: probing in place costs the server's one process life when it is one
    // of the servers that exits on a pre-initialize request. Anything that is
    // not a clean modern answer means legacy, which is what the spec's probe
    // order already mandates -- so pin and reconnect rather than fail.
    const message = e instanceof Error ? e.message : String(e);
    if (!/negotiation failed/i.test(message)) throw e;
    client = new (Client as any)(info, { capabilities: CLIENT_CAPABILITIES });
    await client.connect(tap(new SeamStdioTransport(transportOptions), opts.onFrame));
  }

  return describe(client);
}
