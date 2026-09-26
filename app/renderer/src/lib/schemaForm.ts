// The form engine (D9; phase 07 decision 3). A tool's inputSchema becomes a
// plan: fields for the subset a form renders faithfully, and a hand-off to the
// JSON editor for everything else. The form and the editor edit one arguments
// value, so they cannot disagree; the form never blocks a value the schema
// allows, because the editor beside it can always write that value.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Args = Record<string, unknown>;
export type Path = string[];

interface Common {
  path: Path;
  /** The property name, the last path segment. */
  label: string;
  title?: string;
  description?: string;
  required: boolean;
}

export type Field =
  | (Common & { kind: 'string'; format?: string; default?: unknown })
  | (Common & { kind: 'number' | 'integer'; minimum?: number; maximum?: number; default?: unknown })
  | (Common & { kind: 'boolean'; default?: unknown })
  | (Common & { kind: 'enum'; options: (string | number | boolean)[]; default?: unknown })
  | (Common & { kind: 'const'; value: unknown })
  | (Common & { kind: 'object'; fields: Field[] })
  | (Common & { kind: 'array'; item: 'string' | 'number' | 'integer' | 'boolean' })
  /** Handed to the JSON editor, with the reason shown beside it. */
  | (Common & { kind: 'editor'; reason: string });

export type FormPlan =
  | { kind: 'form'; fields: Field[]; /** Other keys the schema allows but the form has no field for. */ open: boolean }
  | { kind: 'editor-only'; reason: string };

/** Deeper than this, a nested object goes to the editor (D9, "deep nesting"). */
export const MAX_DEPTH = 3;

const COMPOSITION = ['$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'dependentSchemas', 'dependentRequired', 'patternProperties', 'propertyNames', 'unevaluatedProperties'];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const composed = (s: Record<string, unknown>) => COMPOSITION.find((k) => k in s);
const PRIMITIVE_ITEMS = new Set(['string', 'number', 'integer', 'boolean']);

export function planForm(schema: unknown): FormPlan {
  if (!isObject(schema)) return { kind: 'editor-only', reason: 'The schema is not an object schema.' };
  const c = composed(schema);
  if (c) return { kind: 'editor-only', reason: `The schema uses ${c} at its root, which the form does not render.` };
  const type = schema.type;
  if (type !== 'object' && !(type === undefined && isObject(schema.properties))) {
    return { kind: 'editor-only', reason: type === undefined ? 'The schema declares no type.' : `The schema's root type is ${JSON.stringify(type)}, not object.` };
  }
  if (schema.properties !== undefined && !isObject(schema.properties)) return { kind: 'editor-only', reason: 'properties is not an object.' };
  return { kind: 'form', fields: objectFields(schema, [], 1), open: schema.additionalProperties !== false };
}

function objectFields(schema: Record<string, unknown>, at: Path, depth: number): Field[] {
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);
  const props = isObject(schema.properties) ? schema.properties : {};
  return Object.entries(props).map(([name, prop]) => field(prop, [...at, name], required.has(name), depth));
}

function field(prop: unknown, path: Path, required: boolean, depth: number): Field {
  const label = path[path.length - 1];
  const common: Common = { path, label, required };
  if (!isObject(prop)) return { ...common, kind: 'editor', reason: 'A boolean schema.' };
  if (typeof prop.title === 'string') common.title = prop.title;
  if (typeof prop.description === 'string') common.description = prop.description;
  const editor = (reason: string): Field => ({ ...common, kind: 'editor', reason });
  const c = composed(prop);
  if (c) return editor(`Uses ${c}.`);
  if ('const' in prop) return { ...common, kind: 'const', value: prop.const };
  if (Array.isArray(prop.enum)) {
    const options = prop.enum;
    if (options.length > 0 && options.every((o) => typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean')) {
      return { ...common, kind: 'enum', options: options as (string | number | boolean)[], ...('default' in prop ? { default: prop.default } : {}) };
    }
    return editor('An enum with values a list cannot show.');
  }
  const t = prop.type;
  const dflt = 'default' in prop ? { default: prop.default } : {};
  if (Array.isArray(t)) return editor(`More than one type: ${t.join(', ')}.`);
  if (t === 'string') return { ...common, kind: 'string', ...(typeof prop.format === 'string' ? { format: prop.format } : {}), ...dflt };
  if (t === 'number' || t === 'integer') {
    return {
      ...common, kind: t,
      ...(typeof prop.minimum === 'number' ? { minimum: prop.minimum } : {}),
      ...(typeof prop.maximum === 'number' ? { maximum: prop.maximum } : {}),
      ...dflt,
    };
  }
  if (t === 'boolean') return { ...common, kind: 'boolean', ...dflt };
  if (t === 'object' || (t === undefined && isObject(prop.properties))) {
    if (depth >= MAX_DEPTH) return editor(`Nested deeper than ${MAX_DEPTH} levels.`);
    if (!isObject(prop.properties) || Object.keys(prop.properties).length === 0) return editor('An object with no declared properties.');
    return { ...common, kind: 'object', fields: objectFields(prop, path, depth + 1) };
  }
  if (t === 'array') {
    const items = prop.items;
    if (isObject(items) && typeof items.type === 'string' && PRIMITIVE_ITEMS.has(items.type) && !composed(items) && !('enum' in items) && !('const' in items)) {
      return { ...common, kind: 'array', item: items.type as 'string' | 'number' | 'integer' | 'boolean' };
    }
    return editor('An array whose items are not one simple type.');
  }
  if (t === 'null') return editor('Only null is allowed.');
  return editor(t === undefined ? 'No type is declared.' : `Type ${JSON.stringify(t)}.`);
}

/** Every field in a plan, nested ones included, depth first. */
export function leaves(fields: Field[]): Field[] {
  return fields.flatMap((f) => (f.kind === 'object' ? leaves(f.fields) : [f]));
}

export function getAt(value: unknown, path: Path): unknown {
  let v: unknown = value;
  for (const k of path) {
    if (!isObject(v) || !Object.hasOwn(v, k)) return undefined;
    v = v[k];
  }
  return v;
}

/**
 * A copy of `args` with the value at `path` set, or removed when `next` is
 * undefined. An object left empty by a removal is removed too, so clearing a
 * nested field does not leave `{}` behind that the user never typed.
 */
export function setAt(args: Args, path: Path, next: unknown): Args {
  const [head, ...rest] = path;
  const copy: Args = { ...args };
  if (rest.length === 0) {
    if (next === undefined) delete copy[head];
    else copy[head] = next;
    return copy;
  }
  const inner = setAt(isObject(copy[head]) ? (copy[head] as Args) : {}, rest, next);
  if (Object.keys(inner).length === 0 && next === undefined) delete copy[head];
  else copy[head] = inner;
  return copy;
}

/**
 * What an input shows for a field's current value. The inverse is `parseInput`;
 * a value the input cannot show (a number field holding a string) returns
 * null, and the field says to use the editor.
 */
export function formatInput(f: Field, v: unknown): string | null {
  if (v === undefined) return '';
  switch (f.kind) {
    case 'string': return typeof v === 'string' ? v : null;
    case 'number': case 'integer': return typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
    case 'boolean': return typeof v === 'boolean' ? String(v) : null;
    case 'enum': return f.options.some((o) => o === v) ? JSON.stringify(v) : null;
    case 'const': return JSON.stringify(v);
    case 'array': return Array.isArray(v) && v.every((x) => typeof x === (f.item === 'integer' ? 'number' : f.item)) ? v.map(String).join('\n') : null;
    default: return null;
  }
}

/**
 * The value an input's text stands for: undefined when empty (an unset
 * optional field is absent, never ""), or `{ error }` when the text is not a
 * value of the field's type. Nothing is coerced beyond the obvious.
 */
export function parseInput(f: Field, text: string): unknown | { error: string } {
  if (text === '') return undefined;
  switch (f.kind) {
    case 'string': return text;
    case 'number': case 'integer': {
      const n = Number(text.trim());
      if (text.trim() === '' || !Number.isFinite(n)) return { error: `${text} is not a number` };
      if (f.kind === 'integer' && !Number.isInteger(n)) return { error: `${text} is not a whole number` };
      return n;
    }
    case 'boolean': return text === 'true' ? true : text === 'false' ? false : { error: 'choose true or false' };
    case 'enum': case 'const': {
      try {
        return JSON.parse(text);
      } catch {
        return { error: 'not one of the choices' };
      }
    }
    case 'array': {
      const lines = text.split(/\r?\n/).filter((l) => l !== '');
      if (f.item === 'string') return lines;
      const out: unknown[] = [];
      for (const line of lines) {
        const one = parseInput({ ...f, kind: f.item === 'boolean' ? 'boolean' : f.item } as Field, line.trim());
        if (isObject(one) && 'error' in one) return { error: `line "${line}": ${(one as { error: string }).error}` };
        out.push(one);
      }
      return out;
    }
    default: return { error: 'edit this in the JSON editor' };
  }
}

export const isInputError = (v: unknown): v is { error: string } => isObject(v) && typeof (v as { error?: unknown }).error === 'string' && Object.keys(v).length === 1;

/** The editor's text for a value: two-space JSON, as the user will read and edit it. */
export const editorText = (args: Args): string => JSON.stringify(args, null, 2);

/** The editor's text as arguments, or why it is not: arguments are a JSON object. */
export function parseEditor(text: string): { args: Args } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (!isObject(v)) return { error: 'Arguments are a JSON object.' };
  return { args: v as Args };
}

/**
 * A value the form alone can produce that fills every required field, for the
 * corpus test's round trip; undefined when a required field is the editor's.
 */
export function sampleArgs(fields: Field[], into: Args = {}): Args | undefined {
  let args = into;
  for (const f of fields) {
    if (f.kind === 'object') {
      // Nested fields carry their full paths, so they write into the same value.
      const inner = sampleArgs(f.fields, args);
      if (inner === undefined) {
        if (f.required) return undefined;
        continue;
      }
      args = getAt(inner, f.path) === undefined ? setAt(inner, f.path, {}) : inner;
      continue;
    }
    const v = sampleValue(f);
    if (v === undefined) {
      if (f.required) return undefined;
      continue;
    }
    args = setAt(args, f.path, v);
  }
  return args;
}

function sampleValue(f: Field): unknown {
  switch (f.kind) {
    case 'string': return f.format === 'date-time' ? '2026-09-25T12:00:00Z' : f.format === 'date' ? '2026-09-25' : f.format === 'uri' ? 'https://example.com/' : f.format === 'email' ? 'a@example.com' : 'x';
    case 'number': return f.minimum ?? f.maximum ?? 1.5;
    case 'integer': return f.minimum ?? f.maximum ?? 1;
    case 'boolean': return true;
    case 'enum': return f.options[0];
    case 'const': return f.value as Json;
    case 'array': return f.item === 'string' ? ['x'] : f.item === 'boolean' ? [true] : [1];
    default: return undefined;
  }
}
