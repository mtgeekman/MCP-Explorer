// Phase 10's renderer logic, imported as TypeScript; Node strips the types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  logLevelControl, listenText, filterNames, taskActions, taskLine, taskSupport, notificationSummary, missingCapabilityText, healthLines, completionParams,
} from '../app/renderer/src/lib/session.ts';

const info = (o) => ({ connected: true, era: 'legacy', revision: '2025-11-25', logLevel: null, subscribed: [], updated: {}, listen: null, ...o });

test('log level: modern can always unset; legacy only before a level is set', () => {
  assert.equal(logLevelControl(info({ era: 'modern' })).options[0], null);
  assert.equal(logLevelControl(info({ logLevel: null })).options[0], null);
  assert.ok(!logLevelControl(info({ logLevel: 'info' })).options.includes(null));
  assert.match(logLevelControl(info({ era: 'modern' })).note, /Nothing is sent when you choose/);
});

test('listen text follows the stream: waiting, acknowledged, ended by each cause', () => {
  assert.match(listenText(null), /No listen stream/);
  const open = { requestId: 1, filter: { toolsListChanged: true }, acknowledged: null, status: 'open' };
  assert.match(listenText(open), /waiting for the server/);
  assert.equal(listenText({ ...open, acknowledged: { toolsListChanged: true, resourceSubscriptions: ['a'] } }), 'Open. The server agreed to send: tool list changes, updates to 1 resource.');
  assert.match(listenText({ ...open, acknowledged: {} }), /agreed to send nothing/);
  assert.equal(listenText({ ...open, status: 'ended', end: { kind: 'cancelled-by-server', reason: 'bye' } }), 'The server cancelled the stream: bye.');
  assert.equal(listenText({ ...open, status: 'ended', end: { kind: 'result', result: {} } }), 'The server ended the stream.');
  assert.deepEqual(filterNames({ taskIds: ['a', 'b'] }), ['2 tasks']);
});

test('task actions: by era and state; none while a request is out', () => {
  const task = (era, status = 'working') => ({ taskId: 't', status, era });
  assert.deepEqual(taskActions({ status: 'task', task: task('legacy') }).map((a) => a.op), ['get', 'result', 'cancel', 'stop']);
  assert.deepEqual(taskActions({ status: 'task', task: task('modern') }).map((a) => a.op), ['get', 'cancel', 'stop']);
  assert.deepEqual(taskActions({ status: 'running', task: task('modern') }), []);
  assert.deepEqual(taskActions({ status: 'awaiting-input', task: task('modern', 'input_required') }).map((a) => a.op), ['cancel']);
  assert.deepEqual(taskActions({ status: 'running' }), []);
  assert.match(taskLine({ status: 'task', task: { ...task('legacy'), pollInterval: 500 } }), /checks only when you press Get status/);
});

test('task support: legacy 2025-11-25 only, from Tool.execution', () => {
  assert.equal(taskSupport({ execution: { taskSupport: 'optional' } }, 'legacy', '2025-11-25'), 'optional');
  assert.equal(taskSupport({ execution: { taskSupport: 'required' } }, 'legacy', '2025-11-25'), 'required');
  assert.equal(taskSupport({ execution: { taskSupport: 'forbidden' } }, 'legacy', '2025-11-25'), null);
  assert.equal(taskSupport({ execution: { taskSupport: 'optional' } }, 'legacy', '2025-06-18'), null, 'no such field on that revision');
  assert.equal(taskSupport({ execution: { taskSupport: 'optional' } }, 'modern', '2026-07-28'), null);
});

test('notification summaries', () => {
  const row = (method, params) => ({ unitId: 1, connectionId: 1, at: 0, method, params });
  assert.equal(notificationSummary(row('notifications/message', { level: 'error', logger: 'db', data: 'x' })), 'error from db: x');
  assert.equal(notificationSummary(row('notifications/tasks', { taskId: 't', status: 'completed' })), 'task t: completed');
  assert.equal(notificationSummary(row('notifications/tools/list_changed', {})), 'list changed');
  assert.equal(notificationSummary(row('notifications/elicitation/complete', { elicitationId: 'e' })), 'elicitation e completed');
});

test('-32021 in words, and nothing for other errors', () => {
  assert.match(missingCapabilityText({ code: -32021, data: { requiredCapabilities: { extensions: { 'x.y/z': {} } } } }), /extensions\.x\.y\/z/);
  assert.equal(missingCapabilityText({ code: -32603 }), undefined);
});

test('health lines: a clean report and one with trouble', () => {
  const base = {
    at: 0, connection: { status: 'connected', era: 'legacy', revision: '2025-11-25' }, server: { name: 's', version: '1' },
    capabilities: [{ name: 'tools', value: {} }], extensions: [], lists: [{ endpoint: 'tools/list', state: 'listed', count: 2 }],
    malformed: [], schemas: [], ping: { status: 'ok', ms: 3 }, unavailable: [],
  };
  assert.equal(healthLines(base).tone, 'ok');
  const bad = healthLines({ ...base, malformed: [{ endpoint: 'tools/list', key: 'x', message: 'bad' }], lists: [{ endpoint: 'prompts/list', state: 'failed', message: 'nope' }] });
  assert.equal(bad.headline, '2 problems found.');
  assert.equal(healthLines({ ...base, connection: { status: 'not-connected', state: 'failed', message: 'gone' } }).tone, 'bad');
});

test('completion params: the ref by target, context only from 2025-06-18 and only with other values', () => {
  assert.deepEqual(completionParams({ kind: 'prompt', name: 'p' }, 'a', { a: 'x', b: 'y' }, '2025-11-25'), { ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'a', value: 'x' }, context: { arguments: { b: 'y' } } });
  assert.deepEqual(completionParams({ kind: 'prompt', name: 'p' }, 'a', { a: 'x', b: 'y' }, '2025-03-26'), { ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'a', value: 'x' } });
  assert.deepEqual(completionParams({ kind: 'template', uriTemplate: 'f://{v}' }, 'v', {}, '2026-07-28'), { ref: { type: 'ref/resource', uri: 'f://{v}' }, argument: { name: 'v', value: '' } });
});
