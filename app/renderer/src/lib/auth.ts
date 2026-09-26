// What a server's sign-in says to the user (plan phase 11 decisions 5, 10, 11
// and 12). Pure, so node:test covers it without a DOM. Every button here
// sends one thing when pressed, and nothing on its own (P2).
import type { AuthReport } from '../../../../packages/backend/dist/index.js';

export type AuthAction = 'sign-in' | 'open' | 'cancel' | 'refresh' | 'sign-out' | 'forget' | 'register-again';

const minutes = (ms: number) => Math.round(ms / 60000);

/** When a token expires, in words, from `now`. */
export function expiryText(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return 'The server did not say when the access token expires.';
  const left = expiresAt - now;
  if (left <= 0) return `The access token expired ${left > -60000 ? 'just now' : `${minutes(-left)} min ago`}.`;
  if (left < 60000) return 'The access token expires in less than a minute.';
  return `The access token expires in ${minutes(left)} min.`;
}

/** The facts the panel lists, in order. */
export function authLines(r: AuthReport, now: number): string[] {
  const lines: string[] = [];
  if (r.pending) lines.push('Waiting for the browser. Open the page, sign in there, and the app finishes on its own when the browser comes back.');
  else if (r.signedIn) lines.push(`Signed in with ${r.issuer}.`);
  else if (r.registration) lines.push(`Not signed in. The app is registered with ${r.issuer}.`);
  else lines.push('Not signed in.');
  if (r.signedIn) {
    lines.push(r.scope ? `Scopes granted: ${r.scope}.` : 'The server did not say which scopes it granted.');
    lines.push(expiryText(r.expiresAt, now));
    lines.push(r.hasRefreshToken ? 'A refresh token is held: Connect refreshes an expired token.' : 'No refresh token: when the access token expires, sign in again.');
  }
  if (r.registration) {
    lines.push(r.registration.kind === 'pre-registered'
      ? `Client ${r.registration.clientId}, entered in this server's settings, redirecting to ${r.registration.redirectUri}.`
      : `Client ${r.registration.clientId}, registered by the app, redirecting to ${r.registration.redirectUri}.`);
  }
  if (r.resource) lines.push(`Tokens are asked for ${r.resource}.`);
  lines.push(r.storage === 'workspace' ? 'Kept in this workspace\'s encrypted database.' : 'Kept for this session only: this workspace is not encrypted, so a sign-in is not stored.');
  return lines;
}

/** Which buttons the panel shows. */
export function authActions(r: AuthReport): AuthAction[] {
  if (r.pending) return ['open', 'cancel'];
  const out: AuthAction[] = ['sign-in'];
  if (r.lastFailure?.failure.kind === 'port-busy') out.push('register-again');
  if (r.signedIn && r.hasRefreshToken) out.push('refresh');
  if (r.signedIn) out.push('sign-out');
  if (r.registration?.kind === 'dynamic') out.push('forget');
  return out;
}

export const ACTION_LABEL: Record<AuthAction, string> = {
  'sign-in': 'Sign in',
  open: 'Open in browser',
  cancel: 'Cancel',
  refresh: 'Refresh token',
  'sign-out': 'Sign out',
  forget: 'Forget registration',
  'register-again': 'Register again',
};

/** The union of two scope strings, each token once, in first-seen order (RFC 6749 §3.3; the 2026-07-28 step-up rule). */
export function scopeUnion(...scopes: (string | undefined)[]): string | undefined {
  const seen: string[] = [];
  for (const s of scopes) for (const t of (s ?? '').split(/\s+/)) if (t && !seen.includes(t)) seen.push(t);
  return seen.length ? seen.join(' ') : undefined;
}

export interface Challenge { status: 401 | 403; scope?: string; error?: string; errorDescription?: string; resourceMetadataUrl?: string }

/** A round's stored error, when it carries a 401 or 403 challenge (decision 10). */
export function challengeIn(error: unknown): Challenge | undefined {
  const auth = (error as { auth?: unknown } | null)?.auth as Challenge | undefined;
  return auth && (auth.status === 401 || auth.status === 403) ? auth : undefined;
}

/** What a failed call offers for its challenge: Refresh and retry, or Sign in with these scopes (decisions 2 and 11). */
export function callAuthOffer(error: unknown, report: AuthReport | null): { kind: 'refresh-retry' | 'sign-in' | 'step-up'; label: string; scope?: string; text: string } | undefined {
  const c = challengeIn(error);
  if (!c) return undefined;
  if (c.status === 403) {
    const scope = scopeUnion(report?.scope, c.scope);
    return { kind: 'step-up', label: 'Sign in with these scopes', ...(scope ? { scope } : {}), text: `The server needs ${c.scope ? `the scopes ${c.scope}` : 'more scope'}${c.errorDescription ? ` (${c.errorDescription})` : ''}. Signing in again asks for ${scope ?? 'them'}; then call again.` };
  }
  const why = c.errorDescription ?? (c.error ? `error ${c.error}` : 'no reason given');
  if (report?.signedIn && report.hasRefreshToken) return { kind: 'refresh-retry', label: 'Refresh and retry', text: `The server refused the access token (${why}).` };
  return { kind: 'sign-in', label: 'Sign in', text: `The server refused the access token (${why}), and there is no refresh token to use.` };
}

/**
 * What Sign in on a refused connect sends (decisions 5 and 11): the
 * challenge, and for a 403 the union of the scopes granted and challenged,
 * so a step-up does not lose what the last sign-in granted (R11-8).
 */
export function signInParams(serverId: string, state: { status: string; failure?: { kind: string; challenge?: Challenge } }, report: { scope?: string } | null): { serverId: string; challenge?: Challenge; scope?: string } {
  const challenge = state.status === 'failed' && state.failure?.kind === 'unauthorized' ? state.failure.challenge : undefined;
  if (!challenge) return { serverId };
  const scope = challenge.status === 403 ? scopeUnion(report?.scope, challenge.scope) : undefined;
  return { serverId, challenge, ...(scope ? { scope } : {}) };
}
