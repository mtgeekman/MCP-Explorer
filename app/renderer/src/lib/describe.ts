// What a connection state says to the user (round 3). Pure, so node:test
// covers it without a DOM. Every failure leads with what the process or
// server did; the protocol message comes second (plan phase 04).
import type { ConnectionState } from '../../../../packages/backend/dist/index.js';

export interface Offer {
  action: 'start-again' | 'leave-stopped' | 'sign-in';
  label: string;
}

export interface StateView {
  /** One line: the status a user reads first. */
  headline: string;
  /** What the process or server did, in order. */
  facts: string[];
  /** The server's stderr, shown as it printed it. */
  stderr?: string;
  /** The protocol-level message, second. */
  protocolMessage?: string;
  offers: Offer[];
  tone: 'idle' | 'busy' | 'ok' | 'bad';
}

export interface ServerContext {
  transport: 'stdio' | 'streamable-http' | 'sse';
  /** The command line as it will run, for stdio. */
  commandLine?: string;
  url?: string;
  platform?: string;
  /** When the tokens now held were obtained (phase 11): a sign-in newer than a failure answers it. */
  signedInAt?: number;
}

const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function exitWords(exit: { code: number | null; signal: string | null; lifetimeMs: number }): string {
  const how = exit.signal ? `was ended by ${exit.signal}` : `exited with code ${exit.code}`;
  return `${how} after ${duration(exit.lifetimeMs)}`;
}

export function describeState(state: ConnectionState, server: ServerContext): StateView {
  switch (state.status) {
    case 'idle':
      return { headline: 'Not connected', facts: server.commandLine ? [`Connecting runs: ${server.commandLine}`] : [], offers: [], tone: 'idle' };
    case 'needs-secrets':
      return { headline: 'This server needs secrets that are not stored', facts: ['Enter them for this session. They are held in memory until the app quits and never written anywhere.'], offers: [], tone: 'idle' };
    case 'connecting':
      return {
        headline: state.step === 'starting' ? 'Starting the process' : 'Negotiating the protocol era',
        facts: [state.era === 'legacy' ? 'Pinned legacy: sending initialize, no probe.' : 'Probing with server/discover; anything but a modern answer means legacy.'],
        offers: [], tone: 'busy',
      };
    case 'connected':
      return {
        headline: `Connected, ${state.era} era, revision ${state.revision}`,
        facts: state.pid === undefined ? [] : [`Process ${state.pid}`],
        offers: [], tone: 'ok',
      };
    case 'closing':
      return { headline: 'Closing', facts: [], offers: [], tone: 'busy' };
    case 'ended': {
      const facts: string[] = [];
      if (state.exit) facts.push(`The process ${exitWords(state.exit)}.`);
      return { headline: state.byUser ? 'Stopped' : 'The server stopped on its own', facts, offers: [], tone: state.byUser ? 'idle' : 'bad' };
    }
    case 'failed':
      return describeFailure(state, server);
  }
}

function describeFailure(state: Extract<ConnectionState, { status: 'failed' }>, server: ServerContext): StateView {
  const f = state.failure;
  const base = { stderr: state.stderr || undefined, protocolMessage: state.message, tone: 'bad' as const };
  switch (f.kind) {
    case 'not-started': {
      const facts = [`${server.commandLine ?? 'The command'} could not be found or run${f.errorCode ? ` (${f.errorCode})` : ''}.`];
      if (server.platform === 'win32') facts.push('On Windows, a .cmd script such as npx must be started through cmd /c.');
      return { ...base, headline: 'The command never started', facts, offers: [] };
    }
    case 'exited': {
      const facts = [`The process started and ${exitWords(f.exit)}.`];
      if (f.lastRequest) facts.push(`It had just been sent ${f.lastRequest}.`);
      if (state.offer === 'as-legacy') {
        facts.push('Some older servers exit on any request before initialize. It is now marked legacy, so starting it again sends initialize and no probe.');
        return { ...base, headline: 'The server exited on the era probe', facts, offers: startAgain('Start again as legacy') };
      }
      return { ...base, headline: 'The process exited before it connected', facts, offers: [] };
    }
    case 'unsupported-version': {
      const facts = [`It lists: ${f.supported.join(', ') || 'no versions'}.`];
      if (state.offer === 'redetect') {
        facts.push('Starting it again probes the era afresh.');
        return { ...base, headline: 'The server no longer speaks the revision it was pinned to', facts, offers: startAgain('Start again and re-detect') };
      }
      return { ...base, headline: 'The server does not speak the revision asked for', facts, offers: [] };
    }
    case 'http-status':
      return { ...base, headline: `The server answered HTTP ${f.status}`, facts: server.url ? [`From ${server.url}.`] : [], offers: [] };
    case 'protocol':
      return { ...base, headline: 'The server answered, but not with a usable MCP handshake', facts: f.code === undefined ? [] : [`Error code ${f.code}.`], offers: [] };
    case 'unauthorized': {
      // Phase 11 decision 2: the Connect's refresh was refused, so the tokens went.
      if (state.auth?.kind === 'refresh-refused') {
        return { ...base, headline: 'The sign-in has expired: sign in again', facts: ['The authorization server refused the refresh token, so the app forgot the tokens it held.'], offers: [{ action: 'sign-in', label: 'Sign in again' }] };
      }
      if (f.challenge.status === 401 && server.signedInAt !== undefined && server.signedInAt > state.at) {
        return { headline: 'Signed in since this failed: connect again', facts: ['The sign-in finished after this connect was refused. Connect sends the new token.'], offers: [], tone: 'idle' };
      }
      const c = describeChallenge(f.challenge);
      return { ...base, ...c, offers: [{ action: 'sign-in', label: f.challenge.status === 403 ? 'Sign in with these scopes' : 'Sign in' }] };
    }
  }
}

/** A 401 or 403 challenge in words: what the server refused, and what it named (phase 11 decision 10). */
export function describeChallenge(c: { status: 401 | 403; scope?: string; error?: string; errorDescription?: string; resourceMetadataUrl?: string }): { headline: string; facts: string[] } {
  const scopeNeeded = c.status === 403 && c.error === 'insufficient_scope';
  const headline = scopeNeeded ? 'The server needs more scopes than this sign-in granted' : 'The server needs you to sign in';
  const facts: string[] = [`It answered HTTP ${c.status}${c.error ? ` (${c.error})` : ''}.`];
  if (c.errorDescription) facts.push(`It said: ${c.errorDescription}`);
  if (c.scope) facts.push(`${scopeNeeded ? 'Scopes it asks for' : 'Scopes it names'}: ${c.scope}.`);
  if (c.resourceMetadataUrl) facts.push(`Its resource metadata: ${c.resourceMetadataUrl}.`);
  return { headline, facts };
}

function startAgain(label: string): Offer[] {
  return [{ action: 'start-again', label }, { action: 'leave-stopped', label: 'Leave stopped' }];
}

/**
 * A command line as the user should read it before anything runs: an
 * argument with a space or a quote in it, or an empty one, is wrapped in
 * double quotes, with its own double quotes shown as \". Backslashes are
 * shown as they are, so a Windows path reads as the path it is. For reading
 * only: arguments are passed to the process one by one, never re-parsed.
 */
export function commandLine(command: string, args: string[] = []): string {
  const quote = (a: string) => (a === '' || /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return [command, ...args].map(quote).join(' ');
}
