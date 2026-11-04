// ci/github-release.mjs against a fake GitHub: the release CI makes for a
// version tag, its notes, its uploads, and the draft taken down on a failure.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { release, sortVersions, assetName, normalizeNotes } from '../ci/github-release.mjs';

const work = mkdtempSync(join(tmpdir(), 'mcpx-release-'));
const servers = [];
after(() => {
  for (const s of servers) s.close();
  rmSync(work, { recursive: true, force: true });
});

const exe = join(work, 'MCP Explorer Setup 0.1.1.exe');
const deb = join(work, 'mcp-explorer_0.1.1_amd64.deb');
writeFileSync(exe, 'exe bytes');
writeFileSync(deb, 'deb bytes');
const NOTES = 'MCP Explorer 0.1.1\n\nThe first public release.\n';

/** A fake GitHub: records every request; `failUpload` answers the first upload 500. */
async function fakeGitHub({ tags = [], failUpload = false } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body });
      const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
      if (req.method === 'GET' && req.url.startsWith('/repos/o/r/tags')) return json(200, tags.map((name) => ({ name })));
      if (req.method === 'POST' && req.url === '/repos/o/r/releases') return json(201, { id: 77 });
      if (req.method === 'POST' && req.url.startsWith('/repos/o/r/releases/77/assets')) return failUpload ? json(500, { message: 'boom' }) : json(201, { id: 1 });
      if (req.method === 'PATCH' && req.url === '/repos/o/r/releases/77') return json(200, { id: 77 });
      if (req.method === 'DELETE' && req.url === '/repos/o/r/releases/77') return json(204);
      json(404, { message: 'unexpected' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { requests, api: base, uploads: base };
}

const args = (gh, over = {}) => ({ tag: 'v0.1.1', notes: NOTES, expectedNotes: NOTES, token: 'tkn', repo: 'o/r', files: [exe, deb], api: gh.api, uploads: gh.uploads, log: () => {}, ...over });

test('a release is a draft, then every file, then published; the notes are the tag message with a link to what changed', async () => {
  const gh = await fakeGitHub({ tags: ['v0.1.0', 'v0.0.9', 'not-a-version'] });
  await release(args(gh));
  assert.deepEqual(gh.requests.map((r) => `${r.method} ${r.url.replace(/\?.*/, '')}`), [
    'GET /repos/o/r/tags',
    'POST /repos/o/r/releases',
    'POST /repos/o/r/releases/77/assets',
    'POST /repos/o/r/releases/77/assets',
    'PATCH /repos/o/r/releases/77',
  ]);
  assert.ok(gh.requests.every((r) => r.auth === 'Bearer tkn'));
  const draft = JSON.parse(gh.requests[1].body);
  assert.equal(draft.draft, true);
  assert.equal(draft.tag_name, 'v0.1.1');
  assert.equal(draft.body, 'MCP Explorer 0.1.1\n\nThe first public release.\n\n**Changes since v0.1.0:** https://github.com/o/r/compare/v0.1.0...v0.1.1');
  assert.equal(new URL(gh.requests[2].url, gh.api).searchParams.get('name'), 'MCP-Explorer-Setup-0.1.1.exe');
  assert.equal(gh.requests[2].body.toString(), 'exe bytes');
  assert.equal(gh.requests[2].type, 'application/octet-stream');
  assert.equal(new URL(gh.requests[3].url, gh.api).searchParams.get('name'), 'mcp-explorer_0.1.1_amd64.deb');
  assert.deepEqual(JSON.parse(gh.requests[4].body), { draft: false });
});

test('the first release has no link: there is no version before it', async () => {
  const gh = await fakeGitHub({ tags: ['v0.1.1'] });
  await release(args(gh));
  assert.equal(JSON.parse(gh.requests[1].body).body, normalizeNotes(NOTES));
});

test('an upload that fails takes the draft down, and the job fails naming the upload', async () => {
  const gh = await fakeGitHub({ failUpload: true });
  await assert.rejects(release(args(gh)), /POST .*\/releases\/77\/assets: 500/);
  assert.deepEqual(gh.requests.slice(-2).map((r) => r.method), ['POST', 'DELETE']);
  assert.ok(!gh.requests.some((r) => r.method === 'PATCH'), 'never published');
});

test('a tag whose message is not the committed notes file is refused before anything is sent', async () => {
  const gh = await fakeGitHub();
  await assert.rejects(release(args(gh, { notes: 'Something else entirely.' })), /message is not release-notes\/v0\.1\.1\.txt/);
  await assert.rejects(release(args(gh, { expectedNotes: undefined })), /release-notes\/v0\.1\.1\.txt is not in the tagged commit/);
  await assert.rejects(release(args(gh, { notes: '' })), /has no message/);
  await assert.rejects(release(args(gh, { files: [join(work, 'missing.exe')] })), /no file at/);
  await assert.rejects(release(args(gh, { token: '' })), /GH_TOKEN is not set/);
  assert.equal(gh.requests.length, 0);
});

test('old valid input: notes equal but for line endings and trailing blank lines are the same notes', async () => {
  const gh = await fakeGitHub();
  await release(args(gh, { notes: NOTES.replace(/\n/g, '\r\n') + '\r\n\r\n' }));
  assert.equal(gh.requests.at(-1).method, 'PATCH');
});

test('versions sort by their numbers, not as text', () => {
  assert.deepEqual(sortVersions(['v0.10.0', 'v0.9.0', 'v0.2.1', 'v1.0.0', 'v0.2.0']), ['v0.2.0', 'v0.2.1', 'v0.9.0', 'v0.10.0', 'v1.0.0']);
  assert.equal(assetName('a  b c.AppImage'), 'a-b-c.AppImage');
});
