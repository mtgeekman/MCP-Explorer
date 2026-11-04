// Makes the GitHub release for a version tag and uploads the installers the
// package jobs kept. Run by CI's release:github, once mirror:github has pushed
// the tag. Modelled on Hive's ci/github-release.sh, in Node so that
// test/github-release.test.mjs can drive it against a fake GitHub.
//
// usage: node ci/github-release.mjs FILE...
//
// Needs CI_COMMIT_TAG, CI_COMMIT_TAG_MESSAGE (the notes), GH_TOKEN and
// GITHUB_REPO (owner/name). GITHUB_API and GITHUB_UPLOADS name other servers,
// for a test.
//
// The notes are the tag's message, and it must be release-notes/<tag>.txt as
// committed: a release cannot carry notes nobody reviewed in a diff. Tag with
// `git tag -a vX.Y.Z -F release-notes/vX.Y.Z.txt --cleanup=verbatim`.
//
// The release starts as a draft, so nobody sees one with half its files, and
// it is taken down again if an upload fails, so the job can run again.
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One line endings, no trailing whitespace at either end: how two notes are compared. */
export const normalizeNotes = (text) => text.replace(/\r\n/g, '\n').trim();

/** The version tags in order, oldest first, by their numbers (v0.10.0 after v0.9.0). */
export function sortVersions(tags) {
  const parts = (t) => t.slice(1).split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  return [...new Set(tags)].sort((a, b) => {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] === y[i]) continue;
      if (x[i] === undefined) return -1;
      if (y[i] === undefined) return 1;
      return typeof x[i] === 'number' && typeof y[i] === 'number' ? x[i] - y[i] : String(x[i]) < String(y[i]) ? -1 : 1;
    }
    return 0;
  });
}

/** The name a file is uploaded under: GitHub turns spaces into dots, so they are dashes here. */
export const assetName = (file) => basename(file).replace(/\s+/g, '-');

/**
 * Releases `tag` on GitHub with `notes` and `files`. Every step names what
 * failed; an upload that fails takes the draft down before the error is thrown.
 */
export async function release({ tag, notes, expectedNotes, token, repo, files, api = 'https://api.github.com', uploads = 'https://uploads.github.com', log = console.log }) {
  if (!tag) throw new Error('this runs for a tag: CI_COMMIT_TAG is not set');
  if (!token) throw new Error('GH_TOKEN is not set for this pipeline');
  if (!repo) throw new Error('GITHUB_REPO is not set');
  if (!notes || !normalizeNotes(notes)) throw new Error(`the tag ${tag} has no message, and the message is the release's notes: use git tag -a`);
  if (expectedNotes === undefined) throw new Error(`release-notes/${tag}.txt is not in the tagged commit`);
  if (normalizeNotes(notes) !== normalizeNotes(expectedNotes)) {
    throw new Error(`the tag ${tag}'s message is not release-notes/${tag}.txt: tag with git tag -a ${tag} -F release-notes/${tag}.txt --cleanup=verbatim`);
  }
  if (!files.length) throw new Error('no files to release');
  for (const f of files) if (!existsSync(f)) throw new Error(`no file at ${f}`);

  const github = async (url, init = {}) => {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...init.headers },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url.replace(/\?.*/, '')}: ${res.status} ${body.slice(0, 300)}`);
    return body ? JSON.parse(body) : undefined;
  };

  // The notes, and a link to what changed since the version before this one, if there is one.
  let body = normalizeNotes(notes);
  const tags = (await github(`${api}/repos/${repo}/tags?per_page=100`)).map((t) => t.name).filter((n) => /^v\d/.test(n));
  const ordered = sortVersions([...tags, tag]);
  const previous = ordered[ordered.indexOf(tag) - 1];
  if (previous) body += `\n\n**Changes since ${previous}:** https://github.com/${repo}/compare/${previous}...${tag}`;

  const draft = await github(`${api}/repos/${repo}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag, body, draft: true }),
  });
  try {
    for (const file of files) {
      const name = assetName(file);
      await github(`${uploads}/repos/${repo}/releases/${draft.id}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: readFileSync(file),
      });
      log(`uploaded ${name}`);
    }
    await github(`${api}/repos/${repo}/releases/${draft.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: false }),
    });
  } catch (e) {
    log('Taking the draft release down.');
    await github(`${api}/repos/${repo}/releases/${draft.id}`, { method: 'DELETE' }).catch((d) => log(`and that failed too: ${d.message}`));
    throw e;
  }
  log(`Released ${tag}: https://github.com/${repo}/releases/tag/${tag}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tag = process.env.CI_COMMIT_TAG;
  const notesFile = join('release-notes', `${tag}.txt`);
  try {
    await release({
      tag,
      notes: process.env.CI_COMMIT_TAG_MESSAGE,
      expectedNotes: existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : undefined,
      token: process.env.GH_TOKEN,
      repo: process.env.GITHUB_REPO,
      files: process.argv.slice(2),
      ...(process.env.GITHUB_API ? { api: process.env.GITHUB_API } : {}),
      ...(process.env.GITHUB_UPLOADS ? { uploads: process.env.GITHUB_UPLOADS } : {}),
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
