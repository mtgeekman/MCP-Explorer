// JSON in the readable pane: pretty or compact, and colored by token. The
// pane is where a person reads (D10); the raw view keeps the exact bytes, so
// nothing here claims to be what crossed the wire. Pure, so node:test covers
// it without a DOM.

export type JsonMode = 'pretty' | 'compact';

/** Above this a block is shown uncolored: a span per token costs too much DOM for a multi-megabyte result. */
export const HIGHLIGHT_LIMIT = 256 * 1024;

export type TokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'space' | 'other'
  /** A string whose content is JSON, shown decoded: open and close wrap the decoded tokens, badge names it. */
  | 'embed-open' | 'embed-close' | 'badge';
export interface Token { kind: TokenKind; text: string }

/** How deep JSON-in-a-string is decoded: a string inside a decoded string, and so on. */
export const EMBED_DEPTH = 3;

/**
 * The decoded value of a string that holds a JSON object or array, or
 * undefined when it holds anything else. A string that merely looks like a
 * number or a word is left a string: only objects and arrays are expanded.
 */
export function embeddedJson(s: string): object | undefined {
  if (s.length > HIGHLIGHT_LIMIT) return undefined;
  const t = s.trimStart();
  if (t[0] !== '{' && t[0] !== '[') return undefined;
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pretty tokens for a value, laid out exactly as JSON.stringify(value, null,
 * 2) lays it out. With `embedded`, a string that holds a JSON object or array
 * is replaced by its decoded value between embed-open and embed-close, after
 * a badge that says so; its text is then not the string's, which is why only
 * Pretty does this and Compact never does.
 */
export function prettyTokens(value: unknown, opts: { embedded: boolean }): Token[] {
  const out: Token[] = [];
  const pad = (n: number) => out.push({ kind: 'space', text: `\n${' '.repeat(n)}` });
  const walk = (v: unknown, indent: number, depth: number): void => {
    if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') v = (v as { toJSON: () => unknown }).toJSON();
    if (typeof v === 'string') {
      const inner = opts.embedded && depth < EMBED_DEPTH ? embeddedJson(v) : undefined;
      if (inner === undefined) return void out.push({ kind: 'string', text: JSON.stringify(v) });
      out.push({ kind: 'embed-open', text: '' }, { kind: 'badge', text: 'JSON in a string' });
      walk(inner, indent, depth + 1);
      return void out.push({ kind: 'embed-close', text: '' });
    }
    if (typeof v === 'number') return void out.push({ kind: Number.isFinite(v) ? 'number' : 'literal', text: JSON.stringify(v) });
    if (typeof v === 'boolean' || v === null) return void out.push({ kind: 'literal', text: String(v) });
    if (typeof v === 'bigint') throw new TypeError('BigInt value can\'t be serialized in JSON');
    if (Array.isArray(v)) {
      if (v.length === 0) return void out.push({ kind: 'punct', text: '[]' });
      out.push({ kind: 'punct', text: '[' });
      v.forEach((item, i) => {
        pad(indent + 2);
        const skip = item === undefined || typeof item === 'function' || typeof item === 'symbol';
        if (skip) out.push({ kind: 'literal', text: 'null' });
        else walk(item, indent + 2, depth);
        if (i < v.length - 1) out.push({ kind: 'punct', text: ',' });
      });
      pad(indent);
      return void out.push({ kind: 'punct', text: ']' });
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined && typeof x !== 'function' && typeof x !== 'symbol');
      if (entries.length === 0) return void out.push({ kind: 'punct', text: '{}' });
      out.push({ kind: 'punct', text: '{' });
      entries.forEach(([k, x], i) => {
        pad(indent + 2);
        out.push({ kind: 'key', text: JSON.stringify(k) }, { kind: 'punct', text: ':' }, { kind: 'space', text: ' ' });
        walk(x, indent + 2, depth);
        if (i < entries.length - 1) out.push({ kind: 'punct', text: ',' });
      });
      pad(indent);
      return void out.push({ kind: 'punct', text: '}' });
    }
    out.push({ kind: 'literal', text: 'undefined' });
  };
  walk(value, 0, 0);
  return out;
}

/**
 * A JSON value as text in the chosen mode. `undefined` (which JSON cannot
 * hold) is shown as the word, not dropped.
 */
export function formatJson(value: unknown, mode: JsonMode): string {
  const text = mode === 'pretty' ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  return text ?? 'undefined';
}

/**
 * Text that is already JSON (the result view builds its blocks as indented
 * strings) in the chosen mode. Text that does not parse is returned as it
 * was, since it can only be shown, not reformatted.
 */
export function reformatJson(text: string, mode: JsonMode): string {
  try {
    return formatJson(JSON.parse(text), mode);
  } catch {
    return text;
  }
}

const TOKEN = /("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])|(\s+)/y;

/**
 * Splits JSON text into tokens for coloring. A string is a key when the next
 * non-space character is a colon. Anything the scanner does not recognise is
 * one `other` token up to the next recognised one, so every character of the
 * input appears in exactly one token, in order.
 */
export function tokenizeJson(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let other = '';
  const flush = () => {
    if (other) tokens.push({ kind: 'other', text: other });
    other = '';
  };
  while (i < text.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(text);
    if (!m) {
      other += text[i];
      i++;
      continue;
    }
    flush();
    const [whole, str, num, lit, punct] = m;
    if (str !== undefined) {
      let j = i + whole.length;
      while (j < text.length && /\s/.test(text[j])) j++;
      tokens.push({ kind: text[j] === ':' ? 'key' : 'string', text: str });
    } else if (num !== undefined) tokens.push({ kind: 'number', text: num });
    else if (lit !== undefined) tokens.push({ kind: 'literal', text: lit });
    else if (punct !== undefined) tokens.push({ kind: 'punct', text: punct });
    else tokens.push({ kind: 'space', text: whole });
    i += whole.length;
  }
  flush();
  return tokens;
}
