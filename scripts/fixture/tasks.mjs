// Tasks for the EXTRAS fixture, on both eras (phase 10 decision 2).
//
// Legacy (2025-11-25 core; set LEGACY_REVISION=2025-11-25): the `tasks`
// capability, Tool.execution.taskSupport, a task-augmented tools/call
// (params.task) answered with CreateTaskResult, and tasks/get, tasks/result
// (which waits until the task is done), tasks/cancel and tasks/list.
// notifications/tasks/status goes out through the broadcast when a task ends.
//
// Modern (the io.modelcontextprotocol/tasks extension, SEP-2663): the server
// decides. When the request's _meta clientCapabilities declares the extension,
// task_work answers resultType "task"; otherwise it runs at once. tasks/get
// carries the result, the error or the inputRequests; tasks/update delivers
// answers; tasks/cancel answers empty. notifications/tasks goes to a listen
// whose filter names the task in taskIds.
//
// Tools:
//   task_work     works for `ms` milliseconds (default 300), then completes,
//                 or fails when `fail` is true
//   task_ask      modern: a task that stops at input_required until
//                 tasks/update answers `confirm`
//   task_elicit   legacy: a task that sends elicitation/create to the client,
//                 tagged with related-task, and completes when it is answered
//   needs_tasks   modern: refuses with -32021 unless the extension is declared;
//                 REQUIRED_EXTENSION names a different one to require
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

const tasks = new Map();
let created = 0;

export const TASK_TOOLS = [
  {
    name: 'task_work', description: 'Works for a while as a task, then completes.',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer', minimum: 0 }, fail: { type: 'boolean' } } },
    execution: { taskSupport: 'optional' },
  },
  { name: 'task_ask', description: 'A task that asks for input before it completes (modern).', inputSchema: { type: 'object', properties: {} } },
  { name: 'task_elicit', description: 'A task that asks the client for input with a request of its own (legacy).', inputSchema: { type: 'object', properties: {} }, execution: { taskSupport: 'required' } },
  { name: 'needs_tasks', description: 'Refuses with -32021 unless the tasks extension is declared (modern).', inputSchema: { type: 'object', properties: {} } },
];

/** Legacy execution is 2025-11-25 only; a modern Tool has no such field. */
export const taskTools = (era) => TASK_TOOLS.map((t) => (era === 'modern' ? { ...t, execution: undefined } : t));

export const TASK_CAPABILITIES = {
  legacy: { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } },
  modern: { extensions: { [TASKS_EXTENSION]: {} } },
};

const declared = (params) => Boolean(params?._meta?.['io.modelcontextprotocol/clientCapabilities']?.extensions?.[TASKS_EXTENSION]);
const iso = (ms) => new Date(ms).toISOString();

function statusOf(t) {
  if (t.status === 'working' && Date.now() - t.started >= t.ms) {
    if (t.waitingFor) t.status = 'input_required';
    else t.status = t.fail ? 'failed' : 'completed';
    t.updated = Date.now();
    t.onEnd?.(t);
  }
  return t.status;
}

function legacyTask(t) {
  statusOf(t);
  return { taskId: t.id, status: t.status, createdAt: iso(t.started), lastUpdatedAt: iso(t.updated), ttl: 60000, pollInterval: 500, ...(t.status === 'failed' ? { statusMessage: 'failed on purpose' } : {}) };
}

function modernTask(t) {
  statusOf(t);
  return { taskId: t.id, status: t.status, createdAt: iso(t.started), lastUpdatedAt: iso(t.updated), ttlMs: 60000, pollIntervalMs: 500 };
}

const resultOf = (t) => ({ content: [{ type: 'text', text: `task ${t.id} done after ${t.ms} ms${t.answer ? ` with ${JSON.stringify(t.answer)}` : ''}` }] });

/**
 * Answers a task message, or returns undefined when it is not one. `ok` and
 * `err` build responses; `notify(task)` announces a task's end.
 */
export async function handleTask(era, msg, ok, err, notify, send) {
  const { method, params = {} } = msg;
  // The client's answer to a task's own request (legacy task_elicit).
  if (method === undefined && typeof msg.id === 'string' && msg.id.startsWith('task-req-')) {
    const t = tasks.get(msg.id.slice('task-req-'.length));
    if (t) { t.answer = msg.result ?? msg.error; t.status = msg.error ? 'failed' : 'completed'; t.updated = Date.now(); t.onEnd?.(t); }
    return null;
  }
  if (method === 'tools/call' && era === 'legacy' && params.name === 'task_elicit') {
    if (params.task === undefined) return err(-32602, 'task_elicit runs only as a task (taskSupport required)');
    const t = { id: `task-${++created}`, ms: Infinity, started: Date.now(), updated: Date.now(), status: 'input_required', onEnd: notify };
    tasks.set(t.id, t);
    setTimeout(() => send({ jsonrpc: '2.0', id: `task-req-${t.id}`, method: 'elicitation/create', params: { message: 'Name the task.', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }, _meta: { 'io.modelcontextprotocol/related-task': { taskId: t.id } } } }), 20);
    return ok({ task: legacyTask(t) });
  }
  if (method === 'tools/call' && ['task_work', 'task_ask', 'needs_tasks'].includes(params.name)) {
    if (params.name === 'needs_tasks') {
      // REQUIRED_EXTENSION names another extension to require, one the client
      // does not declare, so the refusal itself can be seen.
      const needed = process.env.REQUIRED_EXTENSION ?? TASKS_EXTENSION;
      const has = params._meta?.['io.modelcontextprotocol/clientCapabilities']?.extensions?.[needed];
      if (era === 'modern' && !has) return err(-32021, 'Missing required client capability', { requiredCapabilities: { extensions: { [needed]: {} } } });
      return ok({ content: [{ type: 'text', text: `${needed} is declared` }] });
    }
    const args = params.arguments ?? {};
    const ms = Number.isInteger(args.ms) ? args.ms : 300;
    const asTask = era === 'legacy' ? params.task !== undefined : declared(params);
    if (!asTask) {
      if (era === 'legacy' && params.name === 'task_work') return ok({ content: [{ type: 'text', text: `ran at once for ${ms} ms` }] });
      if (era === 'modern') return ok({ content: [{ type: 'text', text: `ran at once for ${ms} ms` }] });
    }
    const t = { id: `task-${++created}`, ms, fail: args.fail === true, started: Date.now(), updated: Date.now(), status: 'working', waitingFor: era === 'modern' && params.name === 'task_ask' ? 'confirm' : undefined, onEnd: notify };
    tasks.set(t.id, t);
    // Time moves only when asked about; a timer announces the end as well.
    setTimeout(() => statusOf(t), ms + 5).unref?.();
    return era === 'legacy' ? ok({ task: legacyTask(t) }) : ok({ resultType: 'task', ...modernTask(t) });
  }
  if (!method?.startsWith('tasks/')) return undefined;
  if (method === 'tasks/list' && era === 'legacy') return ok({ tasks: [...tasks.values()].map(legacyTask) });
  const t = tasks.get(params.taskId);
  if (!t) return err(-32602, `no task ${JSON.stringify(params.taskId)}`);

  if (era === 'legacy') {
    if (method === 'tasks/get') return ok(legacyTask(t));
    if (method === 'tasks/cancel') {
      if (statusOf(t) === 'working') { t.status = 'cancelled'; t.updated = Date.now(); t.onEnd?.(t); }
      return ok(legacyTask(t));
    }
    if (method === 'tasks/result') {
      while (statusOf(t) === 'working') await new Promise((r) => setTimeout(r, 20));
      const related = { _meta: { 'io.modelcontextprotocol/related-task': { taskId: t.id } } };
      if (t.status === 'failed') return err(-32603, 'the task failed on purpose');
      if (t.status === 'cancelled') return err(-32603, 'the task was cancelled');
      return ok({ ...resultOf(t), ...related });
    }
    return undefined;
  }

  if (method === 'tasks/get') {
    const task = modernTask(t);
    if (t.status === 'completed') return ok({ resultType: 'complete', ...task, result: resultOf(t) });
    if (t.status === 'failed') return ok({ resultType: 'complete', ...task, error: { code: -32603, message: 'the task failed on purpose' } });
    if (t.status === 'input_required') {
      return ok({ resultType: 'complete', ...task, inputRequests: { confirm: { method: 'elicitation/create', params: { mode: 'form', message: 'Carry on with the task?', requestedSchema: { type: 'object', properties: { go: { type: 'boolean' } }, required: ['go'] } } } } });
    }
    return ok({ resultType: 'complete', ...task });
  }
  if (method === 'tasks/update') {
    if (t.status !== 'input_required') return err(-32602, `task ${t.id} is not waiting for input`);
    if (!params.inputResponses?.confirm) return err(-32602, 'no answer for confirm');
    t.answer = params.inputResponses.confirm;
    t.waitingFor = undefined;
    t.status = 'completed';
    t.updated = Date.now();
    t.onEnd?.(t);
    return ok({ resultType: 'complete' });
  }
  if (method === 'tasks/cancel') {
    if (['working', 'input_required'].includes(statusOf(t))) { t.status = 'cancelled'; t.updated = Date.now(); t.onEnd?.(t); }
    return ok({ resultType: 'complete' });
  }
  return undefined;
}

export { legacyTask, modernTask };
