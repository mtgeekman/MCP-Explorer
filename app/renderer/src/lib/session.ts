// Phase 10's words and choices for the renderer, DOM-free so
// test/session-lib.test.mjs can read them: the log level control per era, the
// listen stream, task actions, the notifications timeline, the health report,
// completions, and the -32021 refusal.
import type { HealthReport, ListenView, LiveCall, LogUnit, NotificationRow, SessionInfo } from '../../../../packages/backend/dist/index.js';
import { LOG_LEVELS, requiredCapabilities, compareRevisions, unavailableFields, type LogLevel } from '../../../../packages/protocol/dist/index.js';

export { LOG_LEVELS };
export type { LogLevel };

/** What the log level control offers, and what choosing one does, per era (decision 5). */
export function logLevelControl(info: SessionInfo): { options: (LogLevel | null)[]; note: string } {
  if (info.era === 'modern') {
    return { options: [null, ...LOG_LEVELS], note: 'Sent on every request from now on, in its _meta. Nothing is sent when you choose. Messages come with the request they belong to.' };
  }
  // Legacy has no way to unset a level once one is set.
  return {
    options: info.logLevel === null ? [null, ...LOG_LEVELS] : [...LOG_LEVELS],
    note: 'Choosing a level sends logging/setLevel once. A legacy server has no way to turn logging off again, only to a higher level.',
  };
}

export const levelLabel = (level: LogLevel | null) => (level === null ? 'Not set: no messages asked for' : level);

/** The listen stream's state in words (decision 7). */
export function listenText(listen: ListenView | null): string {
  if (!listen) return 'No listen stream is open. On this revision a server sends change notices and resource updates only on one.';
  if (listen.status === 'open') {
    if (!listen.acknowledged) return 'Listen request sent; waiting for the server to acknowledge it.';
    const honoured = filterNames(listen.acknowledged);
    return honoured.length ? `Open. The server agreed to send: ${honoured.join(', ')}.` : 'Open, and the server agreed to send nothing of what was asked.';
  }
  const end = listen.end;
  if (!end || end.kind === 'closed') return 'Closed.';
  if (end.kind === 'result') return 'The server ended the stream.';
  if (end.kind === 'cancelled-by-server') return `The server cancelled the stream${typeof end.reason === 'string' ? `: ${end.reason}` : ''}.`;
  if (end.kind === 'error') return `The server refused the listen: ${String(end.error.message ?? end.error.code)}.`;
  return `The stream ended: ${end.message}.`;
}

/** A SubscriptionFilter's contents as the user would name them. */
export function filterNames(filter: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (filter.toolsListChanged === true) out.push('tool list changes');
  if (filter.promptsListChanged === true) out.push('prompt list changes');
  if (filter.resourcesListChanged === true) out.push('resource list changes');
  const subs = Array.isArray(filter.resourceSubscriptions) ? filter.resourceSubscriptions : [];
  if (subs.length) out.push(`updates to ${subs.length} resource${subs.length === 1 ? '' : 's'}`);
  const tasks = Array.isArray(filter.taskIds) ? filter.taskIds : [];
  if (tasks.length) out.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
  return out;
}

/** The buttons a task call offers, by era. Nothing here is done without a press (decision 2). */
export function taskActions(live: LiveCall | undefined): { op: 'get' | 'result' | 'cancel' | 'stop'; label: string }[] {
  if (!live?.task || live.status === 'running') return [];
  if (live.status === 'awaiting-input') return [{ op: 'cancel', label: 'Cancel the task' }];
  const actions: { op: 'get' | 'result' | 'cancel' | 'stop'; label: string }[] = [{ op: 'get', label: 'Get status' }];
  if (live.task.era === 'legacy') actions.push({ op: 'result', label: 'Get result' });
  actions.push({ op: 'cancel', label: 'Cancel the task' }, { op: 'stop', label: 'Stop watching' });
  return actions;
}

/** The task as last reported, in one line. */
export function taskLine(live: LiveCall): string {
  const t = live.task!;
  const parts = [`Task ${t.taskId}: ${t.status}`];
  if (t.statusMessage) parts.push(t.statusMessage);
  if (t.pollInterval !== undefined) parts.push(`the server suggests checking every ${t.pollInterval} ms; the app checks only when you press Get status`);
  return parts.join('. ') + '.';
}

/**
 * Whether a tool offers to run as a task (2025-11-25 Tool.execution), and
 * whether it must. Modern tools carry no such field: the server decides.
 */
export function taskSupport(tool: { execution?: unknown }, era: 'legacy' | 'modern', revision: string): 'optional' | 'required' | null {
  if (era !== 'legacy' || unavailableFields(revision).includes('tool.execution')) return null;
  const ts = (tool.execution as { taskSupport?: unknown } | undefined)?.taskSupport;
  return ts === 'optional' || ts === 'required' ? ts : null;
}

/** A timeline row's one-line summary; the raw params are shown beside it (D10). */
export function notificationSummary(n: NotificationRow): string {
  const p = (n.params ?? {}) as Record<string, unknown>;
  switch (n.method) {
    case 'notifications/message': return `${String(p.level ?? '?')}${typeof p.logger === 'string' ? ` from ${p.logger}` : ''}: ${typeof p.data === 'string' ? p.data : JSON.stringify(p.data)}`;
    case 'notifications/resources/updated': return `updated: ${String(p.uri)}`;
    case 'notifications/subscriptions/acknowledged': return `the server will send: ${filterNames((p.notifications ?? {}) as Record<string, unknown>).join(', ') || 'nothing asked for'}`;
    case 'notifications/progress': return `progress ${String(p.progress)}${p.total !== undefined ? ` of ${String(p.total)}` : ''}`;
    case 'notifications/tasks/status':
    case 'notifications/tasks': return `task ${String(p.taskId)}: ${String(p.status)}`;
    case 'notifications/elicitation/complete': return `elicitation ${String(p.elicitationId)} completed`;
    case 'notifications/cancelled': return `cancelled request ${JSON.stringify(p.requestId)}${typeof p.reason === 'string' ? `: ${p.reason}` : ''}`;
    default: return n.method.endsWith('/list_changed') ? 'list changed' : '';
  }
}

/**
 * Whether a newly logged unit is a reason to read the timeline again: only
 * while it is open, and only for an inbound notification of its own server
 * (R10-5). A chatty server must not make a hidden panel query the log.
 */
export function reloadsTimeline(open: boolean, serverId: string, unit: Pick<LogUnit, 'serverId' | 'direction' | 'frames'>): boolean {
  return open && unit.serverId === serverId && unit.direction === 'in' && unit.frames.some((f) => f.method !== null && f.jsonrpcId === null);
}

/**
 * On modern stdio a log message says nothing of which request it belongs to
 * (the schema carries no key for it): the timeline is in arrival order.
 */
export const ARRIVAL_ORDER_NOTE = 'In the order they arrived. On this revision over stdio a log message carries nothing that ties it to its request.';

/** What a -32021 refusal asks for, in words, or undefined for any other error. */
export function missingCapabilityText(error: unknown): string | undefined {
  const names = requiredCapabilities(error as { code?: unknown; data?: unknown } | null);
  if (names === undefined) return undefined;
  if (names.length === 0) return 'The server requires a client capability this app did not declare, and did not say which.';
  return `The server requires client capabilities this app did not declare: ${names.join(', ')}. The app declares what it can answer; this one it cannot.`;
}

/** The health report's headline and its sections as lines (decision 12). */
export function healthLines(r: HealthReport): { headline: string; tone: 'ok' | 'bad' | 'warn'; sections: { title: string; lines: string[] }[] } {
  if (r.connection.status !== 'connected') return { headline: `Could not reach the server: ${r.connection.message}`, tone: 'bad', sections: [] };
  const failing = r.lists.filter((l) => l.state === 'failed');
  const trouble = failing.length + r.malformed.length + r.schemas.length + (r.ping.status === 'failed' ? 1 : 0);
  const sections = [
    { title: 'Server', lines: [`${r.server?.name ?? 'unnamed'} ${r.server?.version ?? ''}`.trim(), `Revision ${r.connection.revision} (${r.connection.era} era)`] },
    { title: 'Capabilities', lines: r.capabilities.length ? r.capabilities.map((c) => `${c.name}: ${JSON.stringify(c.value)}`) : ['None declared.'] },
    { title: 'Extensions', lines: r.extensions.length ? r.extensions : [r.connection.era === 'modern' ? 'None advertised.' : 'Not on this revision: extensions arrived in 2026-07-28.'] },
    {
      title: 'Lists', lines: r.lists.map((l) => (l.state === 'listed' ? `${l.endpoint}: ${l.count} listed` : l.state === 'not-advertised' ? `${l.endpoint}: not advertised` : `${l.endpoint}: advertised, and failed: ${l.message}`)),
    },
    { title: 'Malformed', lines: r.malformed.length ? r.malformed.map((m) => `${m.endpoint} ${m.key ?? ''}: ${m.message}`) : ['Nothing malformed.'] },
    { title: 'Schemas', lines: r.schemas.length ? r.schemas.map((s) => `${s.tool} ${s.field}: ${s.message}`) : ['Every schema compiles.'] },
    { title: 'Ping', lines: [r.ping.status === 'ok' ? `Answered in ${r.ping.ms} ms.` : r.ping.status === 'failed' ? `Failed: ${r.ping.message}` : `Not sent: ${r.ping.reason}.`] },
  ];
  if (r.unavailable.length) sections.push({ title: 'Unavailable on this revision', lines: r.unavailable });
  if (r.captureError) sections.push({ title: 'Capture', lines: [`The capture recorded nothing: ${r.captureError}`] });
  return { headline: trouble === 0 ? 'Healthy: every list answered and nothing is malformed.' : `${trouble} problem${trouble === 1 ? '' : 's'} found.`, tone: trouble === 0 ? 'ok' : 'warn', sections };
}

/**
 * The completion/complete params for one argument (decision 3): a prompt's
 * argument or a template's variable, with the others as context on revisions
 * that carry it (2025-06-18 on).
 */
export function completionParams(target: { kind: 'prompt'; name: string } | { kind: 'template'; uriTemplate: string }, argument: string, values: Record<string, unknown>, revision: string): Record<string, unknown> {
  const ref = target.kind === 'prompt' ? { type: 'ref/prompt', name: target.name } : { type: 'ref/resource', uri: target.uriTemplate };
  const others = Object.fromEntries(Object.entries(values).filter(([k, v]) => k !== argument && typeof v === 'string' && v !== ''));
  // CompleteRequest.context arrived in 2025-06-18.
  const hasContext = compareRevisions(revision, '2025-06-18') >= 0 && Object.keys(others).length > 0;
  return { ref, argument: { name: argument, value: typeof values[argument] === 'string' ? values[argument] : '' }, ...(hasContext ? { context: { arguments: others } } : {}) };
}
