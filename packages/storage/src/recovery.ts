import { createHash } from 'node:crypto';
import { StorageError } from './errors.js';

/**
 * Recovery keys (D28 B): a keychain-custody workspace's raw 256-bit key,
 * encoded for a human to write down or store in a password manager.
 *
 *   MCPX1-XXXX-XXXX-...-XXXX-CCCC
 *
 * - `MCPX1` names the format, so a later format can be told apart.
 * - 52 Crockford base32 characters carry the 32-byte key (260 bits; the last
 *   4 are zero).
 * - `CCCC` is 20 bits of SHA-256 over the key: a mistyped key is reported as
 *   mistyped, not as "wrong key", which would read as "this is not your
 *   workspace". 20 bits is a typo check, not an integrity guarantee -- the
 *   database's own HMAC is what rejects a wrong key.
 *
 * Decoding forgives what people do when copying by hand: any case, dashes or
 * spaces anywhere, and Crockford's aliases (I and L read as 1, O as 0).
 */
export class InvalidRecoveryKeyError extends StorageError {}

const PREFIX = 'MCPX1';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_CHARS = 52;
const CHECK_CHARS = 4;

function toBase32(bytes: Buffer, chars: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (out.length < chars) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text: string, byteCount: number): Buffer {
  const out = Buffer.alloc(byteCount);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of text) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      if (index < byteCount) out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  // Canonical encodings only: the padding bits past the key must be zero, so
  // exactly one string decodes to each key and a changed last character is
  // caught rather than silently ignored.
  if (value !== 0) throw new InvalidRecoveryKeyError('recovery key is mistyped (its last character is not valid for a key)');
  return out;
}

const checksum = (key: Buffer) => toBase32(createHash('sha256').update(key).digest().subarray(0, 3), CHECK_CHARS);

export function encodeRecoveryKey(key: Buffer): string {
  if (key.length !== 32) throw new StorageError(`a workspace key is 32 bytes, got ${key.length}`);
  const body = toBase32(key, KEY_CHARS) + checksum(key);
  return [PREFIX, ...body.match(/.{4}/g)!].join('-');
}

export function decodeRecoveryKey(text: string): Buffer {
  // Aliases apply to the prefix too ("MCPXl" is a copying mistake, not another
  // format); "MCPX" itself contains none of I, L or O.
  const compact = text.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (!compact.startsWith(PREFIX)) {
    throw new InvalidRecoveryKeyError(`recovery key must start with ${PREFIX}`);
  }
  const body = compact.slice(PREFIX.length);
  if (body.length !== KEY_CHARS + CHECK_CHARS) {
    throw new InvalidRecoveryKeyError(`recovery key has ${body.length} characters after ${PREFIX}; expected ${KEY_CHARS + CHECK_CHARS}`);
  }
  const bad = [...body].find((ch) => !ALPHABET.includes(ch));
  if (bad !== undefined) throw new InvalidRecoveryKeyError(`recovery key contains "${bad}", which is not a recovery key character`);
  const key = fromBase32(body.slice(0, KEY_CHARS), 32);
  if (checksum(key) !== body.slice(KEY_CHARS)) {
    throw new InvalidRecoveryKeyError('recovery key is mistyped (its checksum does not match)');
  }
  return key;
}
