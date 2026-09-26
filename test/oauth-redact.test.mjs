// Phase 11 decision 1 and the pillar amendment of 2026-09-26: an OAuth
// exchange is logged with its secret values replaced, and nothing else about
// its bytes changes. The request still goes out, and the caller still reads,
// the real bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { redactAuthBody, redactUrl, loggingFetch } from '../packages/protocol/dist/index.js';

const text = (b) => Buffer.from(b).toString('utf8');
const bytes = (s) => Buffer.from(s, 'utf8');

test('a token response has each secret value replaced, and every other byte kept', () => {
  const body = '{"access_token":"at-123","token_type":"Bearer",\n  "expires_in":3600, "refresh_token" : "rt-\\"456","scope":"read"}';
  const r = redactAuthBody(bytes(body), 'application/json; charset=utf-8');
  assert.deepEqual(r.fields, ['access_token', 'refresh_token']);
  assert.equal(text(r.bytes), '{"access_token":"<secret: access_token>","token_type":"Bearer",\n  "expires_in":3600, "refresh_token" : "<secret: refresh_token>","scope":"read"}');
  assert.doesNotThrow(() => JSON.parse(text(r.bytes)));
});

test('a form token request has code, verifier, refresh token and client secret replaced, the rest kept', () => {
  const body = 'grant_type=authorization_code&code=abc%2F1&code_verifier=v~x&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcallback&client_id=c1&client_secret=s%20s&resource=https%3A%2F%2Fx';
  const r = redactAuthBody(bytes(body), 'application/x-www-form-urlencoded');
  assert.deepEqual(r.fields, ['code', 'code_verifier', 'client_secret']);
  const params = new URLSearchParams(text(r.bytes));
  assert.equal(params.get('code'), '<secret: code>');
  assert.equal(params.get('code_verifier'), '<secret: code_verifier>');
  assert.equal(params.get('client_secret'), '<secret: client_secret>');
  assert.equal(params.get('client_id'), 'c1');
  assert.ok(text(r.bytes).startsWith('grant_type=authorization_code&code='));
  assert.ok(text(r.bytes).includes('&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcallback&client_id=c1&'), 'untouched pairs keep their exact encoding');
});

test('a registration response has its client secret and registration token replaced', () => {
  const r = redactAuthBody(bytes('{"client_id":"c1","client_secret":"s","registration_access_token":"t","redirect_uris":["http://127.0.0.1:1/callback"]}'), 'application/json');
  assert.deepEqual(r.fields, ['client_secret', 'registration_access_token']);
  assert.equal(JSON.parse(text(r.bytes)).client_id, 'c1');
});

test('a metadata document is left byte for byte, and returns the same buffer', () => {
  const input = bytes('{"issuer":"https://as","authorization_endpoint":"https://as/authorize","response_types_supported":["code"],"code_challenge_methods_supported":["S256"]}');
  const r = redactAuthBody(input, 'application/json');
  assert.deepEqual(r.fields, []);
  assert.equal(r.bytes, input);
});

test('a body whose content type lies is still redacted', () => {
  assert.deepEqual(redactAuthBody(bytes('{"access_token":"x"}'), 'text/plain').fields, ['access_token']);
  assert.deepEqual(redactAuthBody(bytes('code=x&state=y'), undefined).fields, ['code']);
});

test('bytes that are not UTF-8, and an empty body, are returned as they are', () => {
  const junk = new Uint8Array([0xff, 0xfe, 0x00]);
  assert.equal(redactAuthBody(junk, 'application/json').bytes, junk);
  assert.deepEqual(redactAuthBody(new Uint8Array(0), 'application/json').fields, []);
});

test('the callback URL has its code replaced and keeps state and iss', () => {
  const r = redactUrl('http://127.0.0.1:5/callback?code=abc&state=s1&iss=https%3A%2F%2Fas#frag');
  assert.deepEqual(r.fields, ['code']);
  assert.equal(r.url, `http://127.0.0.1:5/callback?code=${encodeURIComponent('<secret: code>')}&state=s1&iss=https%3A%2F%2Fas#frag`);
  assert.deepEqual(redactUrl('http://127.0.0.1:5/callback').fields, []);
});

test('the auth fetch logs redacted bodies and names the fields, while the server and the caller see the real bytes', async (t) => {
  let received = '';
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      received = b;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"access_token":"real-at","token_type":"Bearer"}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/token`;
  const units = [];
  const f = loggingFetch((u) => units.push(u), [], fetch, true);
  const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'real-rt' }) });
  assert.equal((await res.json()).access_token, 'real-at', 'the caller reads the real token');
  assert.equal(received, 'grant_type=refresh_token&refresh_token=real-rt', 'the server gets the real request');
  const [out, inn] = units;
  assert.deepEqual(out.http.redacted, ['refresh_token']);
  assert.ok(!text(out.bytes).includes('real-rt'));
  assert.deepEqual(inn.http.redacted, ['access_token']);
  assert.ok(!text(inn.bytes).includes('real-at'));
});

test('without redactSecrets the logging fetch still logs byte-exact (the MCP path is unchanged)', async (t) => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"access_token":"x"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const units = [];
  await (await loggingFetch((u) => units.push(u), [])(`http://127.0.0.1:${server.address().port}/`)).text();
  const inn = units.find((u) => u.direction === 'in');
  assert.equal(text(inn.bytes), '{"access_token":"x"}');
  assert.equal(inn.http.redacted, undefined);
});
