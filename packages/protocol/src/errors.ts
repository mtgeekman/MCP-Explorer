// Protocol errors the app names rather than shows as bare codes.

/** 2026-07-28: the request needs a client capability the client did not declare. */
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;

/**
 * For a -32021 error, the capabilities the server says it requires, as dotted
 * paths ("extensions.io.modelcontextprotocol/tasks", "sampling.tools"), read
 * from data.requiredCapabilities. Undefined for any other error; an empty list
 * when the server named none.
 */
export function requiredCapabilities(error: { code?: unknown; data?: unknown } | null | undefined): string[] | undefined {
  if (!error || error.code !== MISSING_REQUIRED_CLIENT_CAPABILITY) return undefined;
  const required = (error.data as { requiredCapabilities?: unknown } | undefined)?.requiredCapabilities;
  const out: string[] = [];
  const walk = (node: unknown, path: string[]) => {
    const entries = node && typeof node === 'object' && !Array.isArray(node) ? Object.entries(node as Record<string, unknown>) : [];
    // A key under extensions is one name, whatever its value holds.
    if (entries.length === 0 || (path.length === 2 && path[0] === 'extensions')) {
      if (path.length > 0) out.push(path.join('.'));
      return;
    }
    for (const [k, v] of entries) walk(v, [...path, k]);
  };
  walk(required, []);
  return out.sort();
}
