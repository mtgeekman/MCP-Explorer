// Checking a value against a JSON Schema a server supplied: a tool's
// arguments against its inputSchema, a result's structuredContent against its
// outputSchema (phase 07 decision 4). Advisory: a verdict is shown, never used
// to refuse a call or a result.

export type Verdict =
  | { valid: true }
  | { valid: false; message: string }
  /** The schema itself could not be used: an unsupported dialect, or a schema Ajv cannot compile. */
  | { valid: null; message: string };

/**
 * Validates with the SDK's own Ajv setup, which picks the dialect from
 * `$schema` (2020-12 when absent). A new validator each time: the SDK caches
 * compiled schemas by `$id`, and two servers may use the same one.
 */
export async function validateAgainst(schema: unknown, value: unknown): Promise<Verdict> {
  const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/client/validators/ajv');
  let check: (v: unknown) => { valid: boolean; errorMessage?: string };
  try {
    check = new AjvJsonSchemaValidator().getValidator(schema as never) as typeof check;
  } catch (e) {
    return { valid: null, message: e instanceof Error ? e.message : String(e) };
  }
  const r = check(value);
  return r.valid ? { valid: true } : { valid: false, message: r.errorMessage ?? 'invalid' };
}

/**
 * A resource template's variables and a URI from it, by the SDK's own RFC 6570
 * implementation, so reading a template reads the URI a client would build.
 */
export async function uriTemplate(template: string): Promise<{ variables: string[]; expand(values: Record<string, string>): string }> {
  const { UriTemplate } = await import('@modelcontextprotocol/client');
  const t = new UriTemplate(template);
  return { variables: [...t.variableNames], expand: (values) => t.expand(values) };
}
