// Secret values in OAuth exchange bodies (spec pillar amendment 2026-09-26,
// plan phase 11 decision 1). D35 keeps secret headers out of the wire log;
// OAuth carries its secrets in bodies, so the auth fetch passes each body
// through here before it is logged. Only the values are replaced; every other
// byte stays as it was sent or received.

/** Fields whose values are credentials in a token, registration or callback exchange. */
export const SECRET_FIELDS = [
  'access_token', 'refresh_token', 'id_token', 'code', 'code_verifier',
  'client_secret', 'registration_access_token', 'client_assertion',
] as const;

const SECRET_SET = new Set<string>(SECRET_FIELDS);

export interface Redaction {
  bytes: Uint8Array;
  /** The fields whose values were replaced, in the order found; empty when nothing was. */
  fields: string[];
}

const placeholder = (field: string) => `<secret: ${field}>`;

/**
 * A JSON string member named for a secret field, anywhere in the text. The
 * value is replaced as a JSON string, so the document stays valid JSON. A key
 * written with escapes is not recognised; no authorization server writes one.
 */
const JSON_MEMBER = new RegExp(`("(${SECRET_FIELDS.join('|')})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'g');

function redactJson(text: string, fields: string[]): string {
  return text.replace(JSON_MEMBER, (_m, prefix: string, name: string) => {
    fields.push(name);
    return `${prefix}"${placeholder(name)}"`;
  });
}

/** `a=1&b=2`: each secret pair's value replaced, every other pair and separator kept byte for byte. */
function redactForm(text: string, fields: string[]): string {
  return text.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    let name: string;
    try {
      name = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
    } catch {
      return pair;
    }
    if (!SECRET_SET.has(name)) return pair;
    fields.push(name);
    return `${pair.slice(0, eq)}=${encodeURIComponent(placeholder(name))}`;
  }).join('&');
}

/**
 * The body as the log may hold it. JSON and form bodies are redacted by field
 * name; a body of another type is scanned both ways, since a server's content
 * type is not trusted to say what it sent. Bytes that are not UTF-8 text carry
 * no field names and are returned as they were.
 */
export function redactAuthBody(bytes: Uint8Array, contentType: string | null | undefined): Redaction {
  if (bytes.length === 0) return { bytes, fields: [] };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { bytes, fields: [] };
  }
  const fields: string[] = [];
  const type = (contentType ?? '').toLowerCase();
  let out: string;
  if (type.includes('json')) out = redactJson(text, fields);
  else if (type.includes('x-www-form-urlencoded')) out = redactForm(text, fields);
  else {
    out = redactJson(text, fields);
    if (fields.length === 0 && !/^\s*[{[]/.test(text)) out = redactForm(text, fields);
  }
  return fields.length === 0 ? { bytes, fields } : { bytes: Buffer.from(out, 'utf8'), fields };
}

/** A URL with each secret query parameter's value replaced: the loopback callback, as the log records it. */
export function redactUrl(url: string): { url: string; fields: string[] } {
  const q = url.indexOf('?');
  if (q < 0) return { url, fields: [] };
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  const fields: string[] = [];
  const redacted = redactForm(query, fields);
  return { url: url.slice(0, q + 1) + redacted + (hash < 0 ? '' : url.slice(hash)), fields };
}
