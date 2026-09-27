/**
 * Headers whose values are credentials whether or not the user marked them
 * secret. The wire log never records their values (D35), and storage never
 * keeps one as plain configuration (D31). One list, so the two cannot drift.
 */
export const ALWAYS_SECRET_HEADERS: readonly string[] = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie'];

/** Header names are case-insensitive (RFC 9110 §5.1). */
export function isAlwaysSecretHeader(name: string): boolean {
  return ALWAYS_SECRET_HEADERS.includes(name.trim().toLowerCase());
}
