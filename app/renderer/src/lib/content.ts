// A call's result as a person reads it (the readable pane beside the raw
// transcript, D10): every content type a revision defines, and anything else
// shown as the JSON it is, labelled, never dropped.

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; src: string | null; bytes: number }
  | { kind: 'audio'; mimeType: string; src: string | null; bytes: number }
  | { kind: 'resource'; uri: string; mimeType?: string; text?: string; blobBytes?: number }
  | { kind: 'resource_link'; uri: string; name?: string; mimeType?: string }
  /** A content type no revision defines, or a malformed one. */
  | { kind: 'unknown'; type: string; json: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const base64Bytes = (data: string) => Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);

/**
 * A data URL for media the server sent, or null when it cannot be shown: a
 * MIME type outside the family, or data that is not base64.
 */
function mediaSrc(family: 'image' | 'audio', mimeType: unknown, data: unknown): string | null {
  if (typeof mimeType !== 'string' || typeof data !== 'string') return null;
  if (!new RegExp(`^${family}/[a-z0-9.+-]+$`, 'i').test(mimeType) || !BASE64.test(data)) return null;
  return `data:${mimeType};base64,${data}`;
}

export function part(block: unknown): Part {
  if (!isObject(block)) return { kind: 'unknown', type: typeof block, json: JSON.stringify(block, null, 2) };
  const unknown = (): Part => ({ kind: 'unknown', type: typeof block.type === 'string' ? block.type : '(none)', json: JSON.stringify(block, null, 2) });
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { kind: 'text', text: block.text } : unknown();
    case 'image':
    case 'audio': {
      const data = typeof block.data === 'string' ? block.data : '';
      return { kind: block.type, mimeType: String(block.mimeType ?? ''), src: mediaSrc(block.type, block.mimeType, block.data), bytes: base64Bytes(data) };
    }
    case 'resource': {
      const r = block.resource;
      if (!isObject(r) || typeof r.uri !== 'string') return unknown();
      return {
        kind: 'resource', uri: r.uri,
        ...(typeof r.mimeType === 'string' ? { mimeType: r.mimeType } : {}),
        ...(typeof r.text === 'string' ? { text: r.text } : {}),
        ...(typeof r.blob === 'string' ? { blobBytes: base64Bytes(r.blob) } : {}),
      };
    }
    case 'resource_link':
      if (typeof block.uri !== 'string') return unknown();
      return { kind: 'resource_link', uri: block.uri, ...(typeof block.name === 'string' ? { name: block.name } : {}), ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}) };
    default:
      return unknown();
  }
}

/** A result, whichever of the three methods returned it, as sections to render. */
export interface ReadableResult {
  isError: boolean;
  /** tools/call: content blocks. prompts/get: one section per message, headed by its role. resources/read: one per content. */
  sections: { heading?: string; parts: Part[] }[];
  structuredContent?: string;
  /** Fields the app does not render, as JSON, so nothing is hidden. */
  other?: string;
}

const RENDERED: Record<'tool' | 'prompt' | 'resource', string[]> = {
  tool: ['content', 'structuredContent', 'isError', 'resultType', '_meta'],
  prompt: ['messages', 'description', 'resultType', '_meta'],
  resource: ['contents', 'resultType', '_meta'],
};

export function readableResult(kind: 'tool' | 'prompt' | 'resource', result: unknown): ReadableResult {
  const r = isObject(result) ? result : {};
  const sections: ReadableResult['sections'] = [];
  if (kind === 'tool') {
    sections.push({ parts: Array.isArray(r.content) ? r.content.map(part) : [] });
  } else if (kind === 'prompt') {
    if (typeof r.description === 'string') sections.push({ heading: 'Description', parts: [{ kind: 'text', text: r.description }] });
    for (const m of Array.isArray(r.messages) ? r.messages : []) {
      const role = isObject(m) && typeof m.role === 'string' ? m.role : 'message';
      sections.push({ heading: role, parts: [part(isObject(m) ? m.content : m)] });
    }
  } else {
    for (const c of Array.isArray(r.contents) ? r.contents : []) {
      if (!isObject(c)) {
        sections.push({ parts: [part(c)] });
        continue;
      }
      const uri = typeof c.uri === 'string' ? c.uri : '(no uri)';
      const p: Part = { kind: 'resource', uri, ...(typeof c.mimeType === 'string' ? { mimeType: c.mimeType } : {}), ...(typeof c.text === 'string' ? { text: c.text } : {}), ...(typeof c.blob === 'string' ? { blobBytes: base64Bytes(c.blob) } : {}) };
      sections.push({ heading: uri, parts: [p] });
    }
  }
  const rest = Object.fromEntries(Object.entries(r).filter(([k]) => !RENDERED[kind].includes(k)));
  return {
    isError: r.isError === true,
    sections,
    ...(kind === 'tool' && r.structuredContent !== undefined ? { structuredContent: JSON.stringify(r.structuredContent, null, 2) } : {}),
    ...(Object.keys(rest).length ? { other: JSON.stringify(rest, null, 2) } : {}),
  };
}

export type CallStatusLabel = { text: string; tone: 'ok' | 'bad' | 'neutral' | 'busy' };

/** A call's state in words. `live` wins: storage says in_progress for both running and waiting. */
export function statusLabel(status: string, live?: { status: 'running' | 'awaiting-input' }): CallStatusLabel {
  if (live?.status === 'running') return { text: 'Running', tone: 'busy' };
  if (live?.status === 'awaiting-input') return { text: 'Waiting for input', tone: 'busy' };
  switch (status) {
    case 'completed': return { text: 'Completed', tone: 'ok' };
    case 'error': return { text: 'Error', tone: 'bad' };
    case 'cancelled': return { text: 'Cancelled', tone: 'neutral' };
    case 'interrupted': return { text: 'Interrupted: the session ended during the call', tone: 'bad' };
    case 'abandoned': return { text: 'Stopped without answering', tone: 'neutral' };
    case 'capped': return { text: 'Stopped at the round limit', tone: 'neutral' };
    case 'in_progress': return { text: 'In progress in another session', tone: 'neutral' };
    default: return { text: status, tone: 'neutral' };
  }
}

/** "3 of 10 (30%)", or just the count when the server gives no total. */
export function progressText(p: { progress: number; total?: number; message?: string }): string {
  const count = p.total !== undefined && p.total > 0 ? `${p.progress} of ${p.total} (${Math.min(100, Math.round((p.progress / p.total) * 100))}%)` : String(p.progress);
  return p.message ? `${count}: ${p.message}` : count;
}
