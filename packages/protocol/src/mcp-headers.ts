// SEP-2243 request headers on the modern era's Streamable HTTP
// (streamable-http.mdx, "Custom headers"): Mcp-Param-* mirrored from a tool
// call's arguments, and the value encoding every Mcp-* header shares.
//
// A port of the SDK's own rules (core-internal/src/shared/mcpParamHeaders.ts in
// @modelcontextprotocol/client 2.0.0), which the package does not export. The
// app sends requests through request(), which never adds these headers, so
// without this a server that requires them answers -32020 (phase 10 decision
// 11). Kept rule for rule, so the two cannot disagree on what a server sees.

export const MCP_PARAM_HEADER_PREFIX = 'Mcp-Param-';
const X_MCP_HEADER_KEY = 'x-mcp-header';
/** RFC 9110 section 5.1 token syntax. */
const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/**
 * The spec names string, integer and boolean; the SDK also admits number,
 * because the conformance suite at its pinned release sends it. Kept, so the
 * app mirrors what the SDK would.
 */
const PERMITTED_TYPES = new Set(['string', 'integer', 'boolean', 'number']);
/** Where a declaration is not statically reachable through properties alone. */
const NON_REACHABLE = ['items', 'prefixItems', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'patternProperties', 'dependentSchemas', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', '$defs', 'definitions'];
const OBJECT_VALUED = new Set(['patternProperties', 'dependentSchemas', '$defs', 'definitions']);

export interface HeaderDeclaration {
  /** The property path through `properties` to the declaring schema. */
  path: string[];
  headerName: string;
  type: string;
}

/** A tool's x-mcp-header declarations, or the first rule they break (the spec makes such a tool invalid). */
export type HeaderScan = { valid: true; declarations: HeaderDeclaration[] } | { valid: false; reason: string };

const pathName = (path: string[]) => (path.length === 0 ? '<root>' : path.join('.'));

export function scanHeaderDeclarations(inputSchema: unknown): HeaderScan {
  const declarations: HeaderDeclaration[] = [];
  const seenLower = new Map<string, string>();
  const visit = (node: unknown, path: string[], reachable: boolean): string | undefined => {
    if (node === null || typeof node !== 'object') return undefined;
    const schema = node as Record<string, unknown>;
    if (X_MCP_HEADER_KEY in schema) {
      if (!reachable || path.length === 0) return `${pathName(path)}: x-mcp-header is only permitted on properties statically reachable through 'properties' keys`;
      const raw = schema[X_MCP_HEADER_KEY];
      if (typeof raw !== 'string' || raw.length === 0) return `${pathName(path)}: x-mcp-header must be a non-empty string`;
      if (!RFC9110_TOKEN.test(raw)) return `${pathName(path)}: x-mcp-header '${raw}' is not a valid RFC 9110 token`;
      const type = typeof schema.type === 'string' ? schema.type : undefined;
      if (type === undefined || !PERMITTED_TYPES.has(type)) return `${pathName(path)}: x-mcp-header is only permitted on primitive-typed properties; got ${type ?? '<none>'}`;
      const lower = raw.toLowerCase();
      const prior = seenLower.get(lower);
      if (prior !== undefined) return `x-mcp-header '${raw}' is not case-insensitively unique (also declared as '${prior}')`;
      seenLower.set(lower, raw);
      declarations.push({ path, headerName: raw, type });
    }
    const properties = schema.properties;
    if (properties !== null && typeof properties === 'object') {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        const fault = visit(child, [...path, key], reachable);
        if (fault !== undefined) return fault;
      }
    }
    for (const k of NON_REACHABLE) {
      const sub = schema[k];
      if (sub === undefined) continue;
      const branches = Array.isArray(sub) ? sub : sub !== null && typeof sub === 'object' && OBJECT_VALUED.has(k) ? Object.values(sub as Record<string, unknown>) : [sub];
      for (const branch of branches) {
        const fault = visit(branch, [...path, `<${k}>`], false);
        if (fault !== undefined) return fault;
      }
    }
    return undefined;
  };
  const fault = visit(inputSchema, [], true);
  return fault === undefined ? { valid: true, declarations } : { valid: false, reason: fault };
}

const BASE64_PREFIX = '=?base64?';
const BASE64_SUFFIX = '?=';

function needsBase64(s: string): boolean {
  if (s.length === 0) return true;
  if (s.startsWith(BASE64_PREFIX) && s.endsWith(BASE64_SUFFIX)) return true;
  if (s !== s.trim()) return true;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || (c >= 32 && c <= 126)) continue;
    return true;
  }
  return false;
}

/** A value as an HTTP field value: plain when safe ASCII, else `=?base64?<utf8 base64>?=`. */
export function encodeHeaderValue(value: string): string {
  return needsBase64(value) ? `${BASE64_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}${BASE64_SUFFIX}` : value;
}

function primitiveText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return undefined;
    return String(value);
  }
  return undefined;
}

function valueAt(root: unknown, path: string[]): unknown {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * The Mcp-Param-* headers for one tools/call: a declared value that is null,
 * absent or not a primitive is left out, as the spec's table says.
 */
export function mcpParamHeaders(declarations: HeaderDeclaration[], args: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of declarations) {
    const raw = valueAt(args, decl.path);
    if (raw === undefined || raw === null) continue;
    const text = primitiveText(raw);
    if (text === undefined) continue;
    out[`${MCP_PARAM_HEADER_PREFIX}${decl.headerName}`] = encodeHeaderValue(text);
  }
  return out;
}
