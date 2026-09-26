// What a server asks the person for, and the answers they give (phase 08).
// DOM-free: test/callbacks-lib.test.mjs imports it. The same requests arrive
// two ways: inside an InputRequiredResult on the modern era, keyed, and as
// server-to-client requests on the legacy era. This reads either.

export type RequestKind = 'sampling' | 'elicitation-form' | 'elicitation-url' | 'roots' | 'other';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Which answer a request takes. An elicitation with no mode is form mode, as every revision says. */
export function requestKind(method: unknown, params: unknown): RequestKind {
  if (method === 'sampling/createMessage') return 'sampling';
  if (method === 'roots/list') return 'roots';
  if (method === 'elicitation/create') {
    const mode = isObject(params) ? params.mode : undefined;
    if (mode === 'url') return 'elicitation-url';
    if (mode === undefined || mode === 'form') return 'elicitation-form';
  }
  return 'other';
}

/**
 * The deprecation line P3 asks for: sampling and roots are deprecated on
 * 2026-07-28 (SEP-2577), which is the only revision that carries them through
 * MRTR. On the legacy revisions none of the three is deprecated.
 */
export function deprecationNote(kind: RequestKind, era: 'legacy' | 'modern'): string | null {
  if (era !== 'modern') return null;
  if (kind === 'sampling') return 'Sampling is deprecated in 2026-07-28 (SEP-2577). The app still answers it.';
  if (kind === 'roots') return 'Roots are deprecated in 2026-07-28 (SEP-2577). The app still answers them.';
  return null;
}

/** One message of a sampling request, as a person reads it. Content the app does not render is shown as its JSON. */
export interface SamplingMessageView {
  role: string;
  text: string | null;
  json: string | null;
}

export interface SamplingView {
  messages: SamplingMessageView[];
  systemPrompt?: string;
  maxTokens?: unknown;
  /** Tool names the server offers the model (2025-11-25 and later). */
  tools: string[];
  toolChoice?: string;
  includeContext?: string;
  modelHints: string[];
  /** Everything else in the params, as JSON, so nothing is hidden. */
  other?: string;
}

const SAMPLING_SHOWN = new Set(['messages', 'systemPrompt', 'maxTokens', 'tools', 'toolChoice', 'includeContext', 'modelPreferences', '_meta']);

export function samplingView(params: unknown): SamplingView {
  const p = isObject(params) ? params : {};
  const messages = (Array.isArray(p.messages) ? p.messages : []).map((m): SamplingMessageView => {
    const role = isObject(m) && typeof m.role === 'string' ? m.role : '(no role)';
    const content = isObject(m) ? m.content : undefined;
    if (isObject(content) && content.type === 'text' && typeof content.text === 'string') return { role, text: content.text, json: null };
    return { role, text: null, json: JSON.stringify(content, null, 2) ?? 'undefined' };
  });
  const prefs = isObject(p.modelPreferences) ? p.modelPreferences : {};
  const hints = Array.isArray(prefs.hints) ? prefs.hints.flatMap((h) => (isObject(h) && typeof h.name === 'string' ? [h.name] : [])) : [];
  const rest = Object.fromEntries(Object.entries(p).filter(([k]) => !SAMPLING_SHOWN.has(k)));
  return {
    messages,
    ...(typeof p.systemPrompt === 'string' ? { systemPrompt: p.systemPrompt } : {}),
    ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
    tools: Array.isArray(p.tools) ? p.tools.flatMap((t) => (isObject(t) && typeof t.name === 'string' ? [t.name] : [])) : [],
    ...(isObject(p.toolChoice) && typeof p.toolChoice.mode === 'string' ? { toolChoice: p.toolChoice.mode } : {}),
    ...(typeof p.includeContext === 'string' ? { includeContext: p.includeContext } : {}),
    modelHints: hints,
    ...(Object.keys(rest).length ? { other: JSON.stringify(rest, null, 2) } : {}),
  };
}

/** The model name a typed sampling reply reports unless the person changes it (decision 7). */
export const HUMAN_MODEL = 'human';

/** A typed reply as the CreateMessageResult it becomes (decision 7). */
export function samplingResult(text: string, model: string): Record<string, unknown> {
  return { role: 'assistant', content: { type: 'text', text }, model, stopReason: 'endTurn' };
}

/** What an elicitation answer is: the action, and the content only when accepted (ElicitResult). */
export type ElicitAction = 'accept' | 'decline' | 'cancel';
export function elicitResult(action: ElicitAction, content?: Record<string, unknown>): Record<string, unknown> {
  return action === 'accept' && content !== undefined ? { action, content } : { action };
}

/** The requested schema of a form elicitation, or undefined when there is none to plan from. */
export function requestedSchema(params: unknown): unknown {
  return isObject(params) ? params.requestedSchema : undefined;
}

export interface UrlView {
  /** The URL exactly as the server sent it. */
  url: string;
  valid: boolean;
  scheme?: string;
  /** The host the browser would contact, as the URL parser reads it (punycode for an IDN). */
  host?: string;
  /** Opening is offered only for http and https (decision 9). */
  openable: boolean;
  warnings: string[];
}

/** A URL a server asks the person to visit, taken apart so the destination is plain (the phishing risk in the plan). */
export function urlView(url: unknown): UrlView {
  if (typeof url !== 'string') return { url: String(url), valid: false, openable: false, warnings: ['The server sent no URL string.'] };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, valid: false, openable: false, warnings: ['This is not a URL the app can read.'] };
  }
  const scheme = parsed.protocol.replace(/:$/, '');
  const warnings: string[] = [];
  if (scheme === 'http') warnings.push('Not https: what you send there travels unencrypted.');
  else if (scheme !== 'https') warnings.push(`The scheme is ${scheme}, not http or https; the app will not open it.`);
  if (parsed.username || parsed.password) warnings.push('The URL carries a user name or password before the host, a common way to disguise where it goes.');
  if (/^xn--|\.xn--/.test(parsed.hostname)) warnings.push('The host is an internationalized name; check the letters are the ones you expect.');
  return { url, valid: true, scheme, host: parsed.host, openable: scheme === 'http' || scheme === 'https', warnings };
}

/**
 * Roots as the person types them, one per line: a URI, then an optional name
 * after whitespace. Blank lines are skipped.
 */
export function rootsResult(text: string): { roots: { uri: string; name?: string }[] } | { error: string } {
  const roots: { uri: string; name?: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [uri, ...name] = trimmed.split(/\s+/);
    try {
      new URL(uri);
    } catch {
      return { error: `"${uri}" is not a URI` };
    }
    roots.push(name.length ? { uri, name: name.join(' ') } : { uri });
  }
  return { roots };
}

/** Roots other than file:// are allowed on the wire but not by the revisions' prose; the person is told, not stopped. */
export const nonFileRoots = (roots: { uri: string }[]): string[] => roots.filter((r) => !r.uri.startsWith('file://')).map((r) => r.uri);

/** The refusal a legacy request gets by default: sampling's is the one every legacy revision names. */
export function defaultRefusal(method: string): { code: number; message: string } {
  return method === 'sampling/createMessage' ? { code: -1, message: 'User rejected sampling request' } : { code: -1, message: 'User rejected the request' };
}

/** A JSON result the person typed, or why it is not one. */
export function parseResult(text: string): { result: Record<string, unknown> } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return isObject(v) ? { result: v } : { error: 'A result is a JSON object.' };
}

/** Whether every key the server asked for has an answer (decision 6). */
export function allAnswered(asked: Record<string, unknown>, answers: Record<string, unknown | undefined>): boolean {
  return Object.keys(asked).every((k) => answers[k] !== undefined);
}

/**
 * The URLs a -32042 error asks the person to visit (URLElicitationRequiredError,
 * 2025-11-25): shown like URL-mode elicitation, nothing opened.
 */
export function urlElicitationsInError(error: unknown): { message?: string; url: string }[] {
  if (!isObject(error) || error.code !== -32042 || !isObject(error.data) || !Array.isArray(error.data.elicitations)) return [];
  return error.data.elicitations.flatMap((e) => (isObject(e) && typeof e.url === 'string' ? [{ url: e.url, ...(typeof e.message === 'string' ? { message: e.message } : {}) }] : []));
}
