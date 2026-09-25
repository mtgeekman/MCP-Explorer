// The renderer's pure modules: what each connection state says (round 3), and
// how the server editor's text fields become a definition. Imported as
// TypeScript directly; Node strips the types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeState, commandLine } from '../app/renderer/src/lib/describe.ts';
import { parseArgs, formatArgs, parseEnv, parseHeaders } from '../app/renderer/src/lib/form.ts';
import { toFields, parseFields, describePurge, formatBytes, MB } from '../app/renderer/src/lib/settings.ts';
import { initialState, outcomes, plan, toggle } from '../app/renderer/src/lib/importReview.ts';

const stdio = { transport: 'stdio', commandLine: 'npx -y some-server', platform: 'linux' };
const failed = (failure, extra = {}) => ({ status: 'failed', failure, message: 'Version negotiation failed', stderr: '', at: 1, ...extra });

test('every failure leads with what the process did, and keeps the protocol message second', () => {
  const v = describeState(failed({ kind: 'exited', exit: { code: 1, signal: null, lifetimeMs: 120 }, lastRequest: 'initialize', diedOnProbe: false }, { stderr: 'boom\n' }), stdio);
  assert.equal(v.headline, 'The process exited before it connected');
  assert.deepEqual(v.facts, ['The process started and exited with code 1 after 120 ms.', 'It had just been sent initialize.']);
  assert.equal(v.stderr, 'boom\n');
  assert.equal(v.protocolMessage, 'Version negotiation failed');
  assert.deepEqual(v.offers, []);
});

test('the three failures a user must tell apart read differently', () => {
  const heads = [
    describeState(failed({ kind: 'not-started', errorCode: 'ENOENT' }), stdio),
    describeState(failed({ kind: 'exited', exit: { code: 1, signal: null, lifetimeMs: 5 }, diedOnProbe: false }), stdio),
    describeState(failed({ kind: 'protocol', code: 'ERA_NEGOTIATION_FAILED' }), stdio),
  ].map((v) => v.headline);
  assert.equal(new Set(heads).size, 3, heads.join(' | '));
});

test('D20: only the two recoverable failures offer to start again, and always with "Leave stopped"', () => {
  const probe = describeState(failed({ kind: 'exited', exit: { code: 1, signal: null, lifetimeMs: 5 }, lastRequest: 'server/discover', diedOnProbe: true }, { offer: 'as-legacy' }), stdio);
  assert.deepEqual(probe.offers.map((o) => o.label), ['Start again as legacy', 'Leave stopped']);
  const moved = describeState(failed({ kind: 'unsupported-version', supported: ['2026-07-28'] }, { offer: 'redetect' }), stdio);
  assert.deepEqual(moved.offers.map((o) => o.label), ['Start again and re-detect', 'Leave stopped']);
  assert.match(moved.facts[0], /2026-07-28/);
  const noOffer = describeState(failed({ kind: 'unsupported-version', supported: [] }), stdio);
  assert.deepEqual(noOffer.offers, []);
});

test('a command that never started on Windows names the cmd /c shape', () => {
  const v = describeState(failed({ kind: 'not-started', errorCode: 'ENOENT' }), { ...stdio, platform: 'win32' });
  assert.ok(v.facts.some((f) => f.includes('cmd /c')));
});

test('a session that ended on its own is bad news, and one the user stopped is not', () => {
  assert.equal(describeState({ status: 'ended', byUser: false, at: 1, connectionId: 1, exit: { code: 3, signal: null, lifetimeMs: 2500 } }, stdio).tone, 'bad');
  assert.equal(describeState({ status: 'ended', byUser: true, at: 1, connectionId: 1 }, stdio).tone, 'idle');
});

test('a command line shows Windows paths as they are and quotes only what needs it', () => {
  assert.equal(commandLine('C:\\Program Files\\nodejs\\node.exe', ['E:\\srv\\server.mjs', '--name', 'a "b"', '']),
    '"C:\\Program Files\\nodejs\\node.exe" E:\\srv\\server.mjs --name "a \\"b\\"" ""');
});

test('arguments are one per line, and an empty one survives the round trip', () => {
  const args = ['-y', '@scope/server', '', 'with space'];
  assert.deepEqual(parseArgs(formatArgs(args)), args);
  assert.deepEqual(parseArgs('a\r\n\r\nb\n'), ['a', 'b']);
});

test('environment and headers parse by line, and a bad line is reported, not guessed', () => {
  assert.deepEqual(parseEnv('A=1\nB=x=y\n'), { value: { A: '1', B: 'x=y' }, errors: [] });
  assert.deepEqual(parseEnv('=nope\nNOEQUALS\nA=1\nA=2').errors, ['line 1: expected NAME=value', 'line 2: expected NAME=value', 'line 4: A is given twice']);
  assert.deepEqual(parseHeaders('Accept: application/json\nX-Empty:').value, { Accept: 'application/json', 'X-Empty': '' });
});

// --- the settings screen (phase 05) --------------------------------------------------

const defaults = { persistResults: true, retentionMaxBytes: 524_288_000, retentionMaxAgeDays: 90, askBeforeCalls: true, mrtrSoftCap: 5 };

test('settings: the defaults read back as 500 MB, and unchanged fields send nothing', () => {
  const f = toFields(defaults);
  assert.equal(f.retentionMaxMb, '500');
  assert.deepEqual(parseFields(f, defaults), { changes: {}, problems: [] });
});

test('settings: only what changed is sent, the size in whole megabytes', () => {
  const f = { ...toFields(defaults), retentionMaxMb: ' 20 ', mrtrSoftCap: '8', askBeforeCalls: false };
  assert.deepEqual(parseFields(f, defaults), { changes: { retentionMaxBytes: 20 * MB, mrtrSoftCap: 8, askBeforeCalls: false }, problems: [] });
});

test('settings: a cap that is not whole megabytes is left alone unless the field changes', () => {
  const odd = { ...defaults, retentionMaxBytes: 1_000_000 };
  const f = toFields(odd);
  assert.equal(f.retentionMaxMb, '1');
  assert.deepEqual(parseFields(f, odd).changes, {});
  assert.deepEqual(parseFields({ ...f, retentionMaxMb: '2' }, odd).changes, { retentionMaxBytes: 2 * MB });
});

test('settings: zero, fractions, signs, words and blanks are problems, and are never sent', () => {
  for (const bad of ['0', '1.5', '-3', 'ten', '', '1e3']) {
    const r = parseFields({ ...toFields(defaults), mrtrSoftCap: bad, retentionMaxAgeDays: bad }, defaults);
    assert.equal(r.problems.length, 2, bad);
    assert.deepEqual(r.changes, {}, bad);
  }
  const huge = parseFields({ ...toFields(defaults), retentionMaxMb: '9007199254740991' }, defaults);
  assert.deepEqual(huge.problems, ['Largest history is too large.']);
});

test('settings: a purge is described in the order the screen shows, and nothing reads as nothing', () => {
  const none = { callsDeleted: 0, framesDeleted: 0, unitsDeleted: 0, connectionsDeleted: 0, usedBytesBefore: 1, usedBytesAfter: 1, overCapWithNothingToPurge: false };
  assert.deepEqual(describePurge(none), []);
  assert.deepEqual(describePurge({ ...none, callsDeleted: 1, unitsDeleted: 3, connectionsDeleted: 2 }), [
    '1 call, with its rounds and frames', '3 connection-level log entries', '2 closed connection records',
  ]);
  assert.equal(formatBytes(524_288_000), '500.0 MB');
  assert.equal(formatBytes(512), '512 B');
});

// --- the import review (phase 05, board 3.3) -------------------------------------------

const draft = (name, extra = {}) => ({ name, transport: 'stdio', command: 'node', env: {}, headers: {}, askFor: { env: [], headers: [] }, suggestedSecrets: { env: [], headers: [] }, ...extra });
const file = (label, entries) => ({ location: { label, client: 'cursor', layout: 'mcpServers', scope: 'user', path: `/${label}` }, problems: [], entries: entries.map((e) => (typeof e === 'string' ? { name: e, location: 'mcpServers', dropped: [], notes: [], raw: '{}', server: draft(e) } : e)) });

test('import review: importable entries start kept with suggested secrets marked; disabled ones have no state', () => {
  const files = [file('a', [
    { name: 'gh', location: 'mcpServers', dropped: [], notes: [], raw: '{}', server: draft('gh', { env: { GITHUB_TOKEN: 't', LOG: 'x' }, suggestedSecrets: { env: ['GITHUB_TOKEN'], headers: [] } }) },
    { name: 'bad', location: 'mcpServers', dropped: [], notes: [], raw: '{}', disabled: 'no' },
  ])];
  const state = initialState(files);
  assert.deepEqual(Object.keys(state), ['0:0']);
  assert.deepEqual(state['0:0'], { keep: true, name: 'gh', onClash: 'skip', secretEnv: ['GITHUB_TOKEN'], secretHeaders: [] });
  const p = plan(files, state, []);
  assert.deepEqual(p.choices.map((c) => [c.name, c.secrets.env]), [['gh', ['GITHUB_TOKEN']]]);
  assert.deepEqual(p.problems, []);
});

test('import review: a taken name is skipped by default, replaced on request, and renaming clears it', () => {
  const files = [file('a', ['fs', 'git'])];
  const existing = [{ id: 'id-fs', name: 'fs' }];
  const state = initialState(files);
  assert.deepEqual(outcomes(files, state, existing).get('0:0').clash, { existing: { id: 'id-fs', name: 'fs' } });
  assert.deepEqual(plan(files, state, existing), { choices: [plan(files, state, existing).choices[0]], skipped: ['fs'], problems: [] });
  assert.equal(plan(files, state, existing).choices[0].name, 'git');
  state['0:0'].onClash = 'replace';
  assert.equal(plan(files, state, existing).choices[0].replaceId, 'id-fs');
  state['0:0'] = { ...state['0:0'], onClash: 'rename' };
  assert.deepEqual(plan(files, state, existing).problems, ['fs (a): fs is still taken; choose another name.']);
  state['0:0'].name = 'fs-2';
  const renamed = plan(files, state, existing);
  assert.deepEqual(renamed.choices.map((c) => [c.name, c.replaceId]), [['fs-2', undefined], ['git', undefined]]);
});

test('import review: the same name twice in one import; the first saved one keeps it, and a skipped one claims nothing', () => {
  const files = [file('user', ['db']), file('project', ['db'])];
  const state = initialState(files);
  const o = outcomes(files, state, []);
  assert.equal(o.get('0:0').result, 'save');
  assert.deepEqual(o.get('1:0').clash, { entry: '0:0' });
  assert.equal(o.get('1:0').result, 'skip');
  state['1:0'].onClash = 'replace';
  assert.match(plan(files, state, []).problems[0], /only a saved server can be replaced/);
  // The first is skipped against a saved server: it claims nothing, so the second is free to replace.
  const existing = [{ id: 'id-db', name: 'db' }];
  const s2 = initialState(files);
  s2['1:0'].onClash = 'replace';
  assert.deepEqual(plan(files, s2, existing).choices.map((c) => [c.name, c.replaceId]), [['db', 'id-db']]);
});

test('import review: unkept entries are not sent; a blank name is a problem; marks for vanished keys are dropped', () => {
  const files = [file('a', ['x', 'y'])];
  const state = initialState(files);
  state['0:0'].keep = false;
  state['0:1'].name = '  ';
  assert.deepEqual(plan(files, state, []), { choices: [], skipped: [], problems: ['y (a): It has no name.'] });
  state['0:1'] = { ...state['0:1'], name: 'y', secretEnv: ['GONE'] };
  assert.deepEqual(plan(files, state, []).choices[0].secrets, { env: [], headers: [] });
  assert.deepEqual(toggle(['A'], 'B', true), ['A', 'B']);
  assert.deepEqual(toggle(['A', 'B'], 'A', false), ['B']);
  assert.deepEqual(toggle(['A'], 'A', true), ['A']);
});
