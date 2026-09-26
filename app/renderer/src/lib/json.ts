// JSON in the readable pane: pretty or compact, and colored by token. The
// pane is where a person reads (D10); the raw view keeps the exact bytes, so
// nothing here claims to be what crossed the wire. Pure, so node:test covers
// it without a DOM.

export type JsonMode = 'pretty' | 'compact';

/** Above this a block is shown uncolored: a span per token costs too much DOM for a multi-megabyte result. */
export const HIGHLIGHT_LIMIT = 256 * 1024;

export type TokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'space' | 'other';
export interface Token { kind: TokenKind; text: string }

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
