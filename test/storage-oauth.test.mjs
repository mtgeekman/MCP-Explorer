// Phase 11 decisions 6 and 7: a pre-registered OAuth client on the server's
// definition, and a sign-in's client and tokens in server_oauth. Secrets in
// an encrypted workspace only (D31), and never readable on disk (acceptance:
// "tokens never appear on disk in plaintext").
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createWorkspaceDb, workspaceKeyAccount, saveServer, loadServer, deleteServer,
  saveGrant, loadGrant, loadGrantFor, forgetGrants,
  InvalidServerDefinitionError, SecretsRequireEncryptionError,
} from '../packages/storage/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-oauth-store-'));
const secrets = memoryStore();
const keyed = [];
after(() => {
  for (const id of keyed) { try { secrets.delete(workspaceKeyAccount(id)); } catch { /* memory store */ } }
  rmSync(root, { recursive: true, force: true });
});
const noSecrets = { get: () => null, set: () => { throw new Error('unexpected keychain write'); }, delete: () => false };

function create(custody, dir = mkdtempSync(join(root, 'w-'))) {
  const workspaceId = randomUUID();
  const req = { path: join(dir, `${workspaceId}.db`), workspaceId, name: 'oauth test', custody, secrets: custody.kind === 'keychain' ? secrets : noSecrets };
  if (custody.kind === 'keychain') keyed.push(workspaceId);
  return { ws: createWorkspaceDb(req), dir };
}

const http = (overrides = {}) => ({ id: randomUUID(), name: 'remote', transport: 'streamable-http', url: 'https://mcp.example.test/mcp', ...overrides });
const grant = (issuer, token) => ({
  issuer, authServer: issuer, resource: 'https://mcp.example.test/mcp',
  client: { clientId: 'c1', redirectUri: 'http://127.0.0.1:43123/callback', source: 'dynamic' },
  tokens: { accessToken: token, refreshToken: `${token}-refresh`, tokenType: 'Bearer', expiresAt: 5 },
});

test('a pre-registered client round-trips on the definition, and an edit replaces it', () => {
  const { ws } = create({ kind: 'keychain' });
  try {
    const def = http({ oauthClient: { clientId: 'pre-1', redirectUri: 'http://127.0.0.1:43123/callback', clientSecret: 's3' } });
    saveServer(ws, def);
    assert.deepEqual(loadServer(ws, def.id), def);
    const { oauthClient: _, ...without } = def;
    saveServer(ws, without);
    assert.equal(loadServer(ws, def.id).oauthClient, undefined);
  } finally {
    ws.close();
  }
});

test('a pre-registered client is refused on stdio, without an id, or with a redirect that is not loopback http with a port', () => {
  const { ws } = create({ kind: 'keychain' });
  try {
    const bad = (oauthClient, extra = {}) => assert.throws(() => saveServer(ws, http({ oauthClient, ...extra })), InvalidServerDefinitionError);
    bad({ clientId: 'x', redirectUri: 'http://127.0.0.1:1/cb' }, { transport: 'stdio', url: undefined, command: 'node' });
    bad({ clientId: '', redirectUri: 'http://127.0.0.1:1/cb' });
    bad({ clientId: 'x', redirectUri: 'https://127.0.0.1:1/cb' });
    bad({ clientId: 'x', redirectUri: 'http://example.test:1/cb' });
    bad({ clientId: 'x', redirectUri: 'http://127.0.0.1/cb' });
    saveServer(ws, http({ oauthClient: { clientId: 'x', redirectUri: 'http://[::1]:5/cb' } }));
  } finally {
    ws.close();
  }
});

test('an unencrypted workspace keeps a public pre-registered client, and refuses its secret and any grant', () => {
  const { ws } = create({ kind: 'none' });
  try {
    const def = http({ oauthClient: { clientId: 'pre-1', redirectUri: 'http://127.0.0.1:43123/callback' } });
    saveServer(ws, def);
    assert.deepEqual(loadServer(ws, def.id).oauthClient, def.oauthClient);
    assert.throws(() => saveServer(ws, http({ oauthClient: { ...def.oauthClient, clientSecret: 's' } })), SecretsRequireEncryptionError);
    assert.throws(() => saveGrant(ws, def.id, grant('https://as', 'at')), SecretsRequireEncryptionError);
    assert.equal(loadGrant(ws, def.id), null);
  } finally {
    ws.close();
  }
});

test('grants: one per issuer, the latest is the one used, and an edit of the server keeps them', () => {
  const { ws } = create({ kind: 'keychain' });
  try {
    const def = http();
    saveServer(ws, def);
    let now = 100;
    saveGrant(ws, def.id, grant('https://a', 'at-a'), () => now++);
    saveGrant(ws, def.id, grant('https://b', 'at-b'), () => now++);
    assert.equal(loadGrant(ws, def.id).issuer, 'https://b');
    saveGrant(ws, def.id, grant('https://a', 'at-a2'), () => now++);
    assert.equal(loadGrant(ws, def.id).tokens.accessToken, 'at-a2');
    assert.equal(loadGrantFor(ws, def.id, 'https://b').tokens.accessToken, 'at-b');
    saveServer(ws, { ...def, name: 'renamed' });
    assert.equal(loadGrant(ws, def.id).tokens.accessToken, 'at-a2', 'editing the server does not sign it out');
  } finally {
    ws.close();
  }
});

test('sign out forgets the tokens and keeps the registration; forgetting registrations drops the rows; delete cascades', () => {
  const { ws } = create({ kind: 'keychain' });
  try {
    const def = http();
    saveServer(ws, def);
    saveGrant(ws, def.id, grant('https://a', 'at'));
    assert.equal(forgetGrants(ws, def.id), 1);
    const kept = loadGrant(ws, def.id);
    assert.equal(kept.tokens, undefined);
    assert.equal(kept.client.clientId, 'c1');
    assert.equal(forgetGrants(ws, def.id), 0, 'nothing more to forget');
    assert.equal(forgetGrants(ws, def.id, true), 1);
    assert.equal(loadGrant(ws, def.id), null);
    saveGrant(ws, def.id, grant('https://a', 'at'));
    deleteServer(ws, def.id);
    assert.equal(ws.db.prepare('SELECT count(*) AS n FROM server_oauth').get().n, 0);
  } finally {
    ws.close();
  }
});

test('acceptance: tokens and a client secret never appear on disk in plaintext', () => {
  const dir = mkdtempSync(join(root, 'disk-'));
  const access = `access-${randomUUID()}`;
  const clientSecret = `client-secret-${randomUUID()}`;
  const control = `plain-client-id-${randomUUID()}`;
  for (const custody of [{ kind: 'keychain' }, { kind: 'passphrase', passphrase: 'correct horse battery staple' }]) {
    const { ws } = create(custody, dir);
    const def = http({ oauthClient: { clientId: control, redirectUri: 'http://127.0.0.1:43123/callback', clientSecret } });
    saveServer(ws, def);
    saveGrant(ws, def.id, grant('https://a', access));
    ws.close();
  }
  // The positive control proves the scan reads the right bytes: an
  // unencrypted workspace stores the client id where the scan finds it.
  const plain = create({ kind: 'none' }, dir);
  saveServer(plain.ws, http({ oauthClient: { clientId: control, redirectUri: 'http://127.0.0.1:1/cb' } }));
  plain.ws.close();
  const bytes = readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('\n');
  assert.ok(bytes.includes(control), 'the positive control is found');
  for (const secret of [access, `${access}-refresh`, clientSecret]) assert.ok(!bytes.includes(secret), 'a secret is readable on disk');
});
