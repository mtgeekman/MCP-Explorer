// Phase 11's renderer logic, imported as TypeScript; Node strips the types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authLines, authActions, expiryText, scopeUnion, challengeIn, callAuthOffer } from '../app/renderer/src/lib/auth.ts';
import { describeState } from '../app/renderer/src/lib/describe.ts';
import { logRows } from '../app/renderer/src/lib/logrows.ts';

const NOW = 1_800_000_000_000;
const report = (o = {}) => ({ preRegistered: false, storage: 'workspace', signedIn: false, warnings: [], ...o });
const signedIn = (o = {}) => report({
  signedIn: true, issuer: 'https://as.test', authorizationServer: 'https://as.test', scope: 'mcp', expiresAt: NOW + 30 * 60000, hasRefreshToken: true,
  registration: { kind: 'dynamic', clientId: 'c1', redirectUri: 'http://127.0.0.1:5/callback' }, ...o,
});

test('expiry in words, past and future, and when the server did not say', () => {
  assert.equal(expiryText(NOW + 30 * 60000, NOW), 'The access token expires in 30 min.');
  assert.equal(expiryText(NOW + 30000, NOW), 'The access token expires in less than a minute.');
  assert.equal(expiryText(NOW - 5000, NOW), 'The access token expired just now.');
  assert.equal(expiryText(NOW - 10 * 60000, NOW), 'The access token expired 10 min ago.');
  assert.match(expiryText(undefined, NOW), /did not say/);
});

test('the panel lines: signed in, registered only, and waiting for the browser; where it is kept', () => {
  const lines = authLines(signedIn(), NOW);
  assert.equal(lines[0], 'Signed in with https://as.test.');
  assert.ok(lines.includes('Scopes granted: mcp.'));
  assert.ok(lines.some((l) => /refresh token is held/.test(l)));
  assert.ok(lines.some((l) => /registered by the app/.test(l)));
  assert.ok(lines.includes('Kept in this workspace\'s encrypted database.'));
  assert.match(authLines(report({ registration: { kind: 'pre-registered', clientId: 'p', redirectUri: 'x' }, issuer: 'https://as.test' }), NOW)[0], /Not signed in\. The app is registered/);
  assert.match(authLines(report({ pending: { authorizationUrl: 'https://as.test/authorize', startedAt: NOW } }), NOW)[0], /Waiting for the browser/);
  assert.ok(authLines(report({ storage: 'session' }), NOW).some((l) => /session only/.test(l)));
});

test('the panel buttons: Open and Cancel while pending; otherwise by what is held', () => {
  assert.deepEqual(authActions(report({ pending: { authorizationUrl: 'u', startedAt: NOW } })), ['open', 'cancel']);
  assert.deepEqual(authActions(report()), ['sign-in']);
  assert.deepEqual(authActions(signedIn()), ['sign-in', 'refresh', 'sign-out', 'forget']);
  assert.deepEqual(authActions(signedIn({ hasRefreshToken: false, registration: { kind: 'pre-registered', clientId: 'p', redirectUri: 'x' } })), ['sign-in', 'sign-out']);
  assert.deepEqual(authActions(report({ lastFailure: { failure: { kind: 'port-busy', port: 5 }, message: 'm', at: NOW } })), ['sign-in', 'register-again']);
});

test('scope union: each token once, in first-seen order', () => {
  assert.equal(scopeUnion('mcp read', 'read admin'), 'mcp read admin');
  assert.equal(scopeUnion(undefined, 'admin'), 'admin');
  assert.equal(scopeUnion(undefined, ''), undefined);
});

test('a round error with a challenge offers Refresh and retry, Sign in, or a step-up with the union', () => {
  assert.equal(challengeIn({ message: 'x' }), undefined);
  assert.equal(callAuthOffer({ message: 'boom' }, signedIn()), undefined);
  const expired = { message: 'Unauthorized', auth: { status: 401, error: 'invalid_token', errorDescription: 'The access token expired' } };
  assert.equal(callAuthOffer(expired, signedIn()).kind, 'refresh-retry');
  assert.match(callAuthOffer(expired, signedIn()).text, /The access token expired/);
  assert.equal(callAuthOffer(expired, signedIn({ hasRefreshToken: false })).kind, 'sign-in');
  const scope = callAuthOffer({ message: 'x', auth: { status: 403, error: 'insufficient_scope', scope: 'mcp admin' } }, signedIn());
  assert.equal(scope.kind, 'step-up');
  assert.equal(scope.scope, 'mcp admin');
});

test('a failed connect: unauthorized offers Sign in; a refused refresh says to sign in again', () => {
  const failed = (failure, extra = {}) => ({ status: 'failed', failure, message: 'm', stderr: '', at: NOW, ...extra });
  const http = { transport: 'streamable-http', url: 'https://mcp.test/mcp' };
  const v = describeState(failed({ kind: 'unauthorized', challenge: { status: 401, scope: 'mcp', resourceMetadataUrl: 'https://mcp.test/.well-known/oauth-protected-resource/mcp' } }), http);
  assert.equal(v.headline, 'The server needs you to sign in');
  assert.deepEqual(v.offers, [{ action: 'sign-in', label: 'Sign in' }]);
  assert.ok(v.facts.some((f) => /oauth-protected-resource/.test(f)));
  const stepUp = describeState(failed({ kind: 'unauthorized', challenge: { status: 403, error: 'insufficient_scope', scope: 'admin' } }), http);
  assert.equal(stepUp.offers[0].label, 'Sign in with these scopes');
  const again = describeState(failed({ kind: 'unauthorized', challenge: { status: 401 } }, { auth: { kind: 'refresh-refused', error: 'invalid_grant' } }), http);
  assert.equal(again.headline, 'The sign-in has expired: sign in again');
  assert.equal(again.offers[0].label, 'Sign in again');
  const since = describeState(failed({ kind: 'unauthorized', challenge: { status: 401 } }), { ...http, signedInAt: NOW + 1 });
  assert.equal(since.headline, 'Signed in since this failed: connect again');
  assert.deepEqual(since.offers, []);
  assert.equal(describeState(failed({ kind: 'unauthorized', challenge: { status: 401 } }), { ...http, signedInAt: NOW - 1 }).headline, 'The server needs you to sign in', 'an older sign-in does not answer a newer refusal');
});

test('a redacted log unit says so in its row', () => {
  const unit = { id: 1, serverId: 's', connectionId: 1, direction: 'in', kind: 'wire', at: NOW, byteLength: 40, bytes: new TextEncoder().encode('{"access_token":"<secret: access_token>"}'), http: { exchange: 2, status: 200, redacted: ['access_token'] }, frames: [] };
  assert.equal(logRows([unit])[0].label, 'HTTP 200, secrets redacted: access_token');
  const out = { ...unit, direction: 'out', http: { exchange: 2, method: 'POST', url: 'https://as.test/token', redacted: ['code', 'code_verifier'] } };
  assert.equal(logRows([out])[0].label, 'POST https://as.test/token, secrets redacted: code, code_verifier');
});
