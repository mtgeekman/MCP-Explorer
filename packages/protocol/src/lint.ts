// Structural checks on one listed item, as the server sent it (phase 10
// decision 12). Capture runs them on the raw entries, before normalization
// coerces a name to a string or drops a description that is not one, so a
// malformed element is reported rather than smoothed over. Each check is a
// rule every revision states; nothing here depends on which revision it is.
import { scanHeaderDeclarations } from './mcp-headers.js';

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => v !== null && typeof v === 'object' && !Array.isArray(v);
const optionalString = (item: Raw, field: string, out: string[]) => {
  if (item[field] !== undefined && typeof item[field] !== 'string') out.push(`${field} is not a string`);
};

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
const TASK_SUPPORT = ['forbidden', 'optional', 'required'];
const AUDIENCE = ['user', 'assistant'];

function name(item: Raw, out: string[]): void {
  if (typeof item.name !== 'string') out.push('name is not a string');
  else if (item.name.length === 0) out.push('name is empty');
}

function objectSchema(item: Raw, field: string, required: boolean, out: string[]): void {
  const s = item[field];
  if (s === undefined) {
    if (required) out.push(`${field} is missing`);
    return;
  }
  if (!isObject(s)) out.push(`${field} is not an object`);
  else if (s.type !== 'object') out.push(`${field} does not have type "object"`);
}

function annotations(value: unknown, out: string[]): void {
  if (value === undefined) return;
  if (!isObject(value)) return void out.push('annotations is not an object');
  if (value.audience !== undefined && (!Array.isArray(value.audience) || value.audience.some((a) => !AUDIENCE.includes(a as string)))) {
    out.push('annotations.audience is not a list of "user" and "assistant"');
  }
  if (value.priority !== undefined && (typeof value.priority !== 'number' || value.priority < 0 || value.priority > 1)) {
    out.push('annotations.priority is not a number from 0 to 1');
  }
  if (value.lastModified !== undefined && typeof value.lastModified !== 'string') out.push('annotations.lastModified is not a string');
}

export function lintTool(item: Raw): string[] {
  const out: string[] = [];
  name(item, out);
  optionalString(item, 'title', out);
  optionalString(item, 'description', out);
  objectSchema(item, 'inputSchema', true, out);
  objectSchema(item, 'outputSchema', false, out);
  if (item.annotations !== undefined) {
    if (!isObject(item.annotations)) {
      out.push('annotations is not an object');
    } else {
      for (const h of HINTS) {
        const v = item.annotations[h];
        if (v !== undefined && typeof v !== 'boolean') out.push(`annotations.${h} is not a boolean (${JSON.stringify(v)})`);
      }
      if (item.annotations.title !== undefined && typeof item.annotations.title !== 'string') out.push('annotations.title is not a string');
    }
  }
  if (item.icons !== undefined && !Array.isArray(item.icons)) out.push('icons is not a list');
  if (item.execution !== undefined) {
    const ts = isObject(item.execution) ? item.execution.taskSupport : undefined;
    if (!isObject(item.execution)) out.push('execution is not an object');
    else if (ts !== undefined && !TASK_SUPPORT.includes(ts as string)) out.push(`execution.taskSupport is not one of ${TASK_SUPPORT.join(', ')}`);
  }
  const scan = scanHeaderDeclarations(item.inputSchema);
  if (!scan.valid) out.push(`invalid x-mcp-header declaration: ${scan.reason} (the specification tells a client to hide this tool; it is shown here)`);
  return out;
}

export function lintPrompt(item: Raw): string[] {
  const out: string[] = [];
  name(item, out);
  optionalString(item, 'title', out);
  optionalString(item, 'description', out);
  if (item.icons !== undefined && !Array.isArray(item.icons)) out.push('icons is not a list');
  if (item.arguments !== undefined) {
    if (!Array.isArray(item.arguments)) {
      out.push('arguments is not a list');
    } else {
      item.arguments.forEach((a, i) => {
        if (!isObject(a)) return void out.push(`arguments[${i}] is not an object`);
        if (typeof a.name !== 'string' || a.name.length === 0) out.push(`arguments[${i}].name is not a non-empty string`);
        if (a.required !== undefined && typeof a.required !== 'boolean') out.push(`arguments[${i}].required is not a boolean`);
      });
    }
  }
  return out;
}

export function lintResource(item: Raw): string[] {
  const out: string[] = [];
  if (typeof item.uri !== 'string' || item.uri.length === 0) out.push('uri is not a non-empty string');
  else if (!URL.canParse(item.uri)) out.push('uri is not a URI');
  name(item, out);
  optionalString(item, 'title', out);
  optionalString(item, 'description', out);
  optionalString(item, 'mimeType', out);
  if (item.size !== undefined && (typeof item.size !== 'number' || !Number.isInteger(item.size) || item.size < 0)) out.push('size is not a whole number of bytes');
  if (item.icons !== undefined && !Array.isArray(item.icons)) out.push('icons is not a list');
  annotations(item.annotations, out);
  return out;
}

export function lintResourceTemplate(item: Raw): string[] {
  const out: string[] = [];
  if (typeof item.uriTemplate !== 'string' || item.uriTemplate.length === 0) out.push('uriTemplate is not a non-empty string');
  else if (!balancedTemplate(item.uriTemplate)) out.push('uriTemplate has an unbalanced { or }');
  name(item, out);
  optionalString(item, 'title', out);
  optionalString(item, 'description', out);
  optionalString(item, 'mimeType', out);
  if (item.icons !== undefined && !Array.isArray(item.icons)) out.push('icons is not a list');
  annotations(item.annotations, out);
  return out;
}

/** RFC 6570 expressions do not nest: every { closes before the next opens. */
function balancedTemplate(t: string): boolean {
  let open = false;
  for (const c of t) {
    if (c === '{') { if (open) return false; open = true; }
    if (c === '}') { if (!open) return false; open = false; }
  }
  return !open;
}
