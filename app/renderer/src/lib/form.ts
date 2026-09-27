// Turning the server editor's text fields into a definition and back. One
// argument per line, so no shell quoting is ever guessed at; NAME=value lines
// for environment variables and `Name: value` lines for headers.
import { isAlwaysSecretHeader } from '../../../../packages/protocol/dist/secret-headers.js';

export interface ParseResult<T> {
  value: T;
  errors: string[];
}

export function parseArgs(text: string): string[] {
  // Blank lines are dropped; a deliberately empty argument is written "".
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => (l.trim() === '""' ? '' : l));
}

export function formatArgs(args: string[] = []): string {
  return args.map((a) => (a === '' ? '""' : a)).join('\n');
}

function parsePairs(text: string, separator: RegExp, what: string): ParseResult<Record<string, string>> {
  const value: Record<string, string> = {};
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    const m = separator.exec(line);
    if (!m || m.index === 0) {
      errors.push(`line ${i + 1}: expected ${what}`);
      return;
    }
    const name = line.slice(0, m.index).trim();
    if (Object.hasOwn(value, name)) errors.push(`line ${i + 1}: ${name} is given twice`);
    value[name] = line.slice(m.index + m[0].length);
  });
  return { value, errors };
}

const HEADER_SEPARATOR = /:\s?/;

export const parseEnv = (text: string) => parsePairs(text, /=/, 'NAME=value');
export const parseHeaders = (text: string) => parsePairs(text, HEADER_SEPARATOR, 'Name: value');

/**
 * The editor's Move to Secrets: takes the credential headers (Authorization,
 * Cookie, ...) out of the plain Headers text, which storage refuses to keep
 * them in (D31). Every other line is left as typed.
 */
export function moveCredentialHeaders(text: string): { headers: string; moved: Record<string, string> } {
  const moved: Record<string, string> = {};
  const kept = text.split(/\r?\n/).filter((line) => {
    const m = HEADER_SEPARATOR.exec(line);
    if (!m || m.index === 0 || !isAlwaysSecretHeader(line.slice(0, m.index))) return true;
    moved[line.slice(0, m.index).trim()] = line.slice(m.index + m[0].length);
    return false;
  });
  return Object.keys(moved).length ? { headers: kept.join('\n'), moved } : { headers: text, moved };
}

export function formatEnv(env: Record<string, string> = {}): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
}

export function formatHeaders(headers: Record<string, string> = {}): string {
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
}
