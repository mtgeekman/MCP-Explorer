import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { StorageError } from './errors.js';

/**
 * The workspace registry (D29): the list the app shows before any workspace
 * is unlocked. A plain JSON file, readable by anyone who can read the user's
 * files, so it holds only what the picker needs -- and no name for a
 * passphrase-protected workspace, whose name lives inside its encrypted
 * database.
 */
export type RegistryCustody = 'none' | 'keychain' | 'passphrase';

export interface RegistryEntry {
  id: string;
  path: string;
  custody: RegistryCustody;
  createdAt: number;
  /** Present for `none` and `keychain`; never present for `passphrase`. */
  name?: string;
}

/** The registry file is unreadable, malformed, or from a newer app. It is never reset. */
export class RegistryError extends StorageError {}

export const REGISTRY_FORMAT = 1;

interface RegistryFile {
  format: number;
  workspaces: RegistryEntry[];
}

const CUSTODIES: readonly RegistryCustody[] = ['none', 'keychain', 'passphrase'];

function checkEntry(e: unknown, where: string): RegistryEntry {
  const entry = e as Partial<RegistryEntry> | null;
  const bad = (why: string) => new RegistryError(`${where}: ${why}`);
  if (typeof entry !== 'object' || entry === null) throw bad('entry is not an object');
  if (typeof entry.id !== 'string' || !entry.id) throw bad('id is missing');
  if (typeof entry.path !== 'string' || !entry.path) throw bad(`workspace ${entry.id} has no path`);
  if (!CUSTODIES.includes(entry.custody as RegistryCustody)) throw bad(`workspace ${entry.id} has unknown custody ${String(entry.custody)}`);
  if (!Number.isSafeInteger(entry.createdAt)) throw bad(`workspace ${entry.id} has no valid createdAt`);
  if (entry.custody === 'passphrase') {
    // D29: a protected workspace's name must not sit in a readable file.
    if (entry.name !== undefined) throw bad(`workspace ${entry.id} is passphrase-protected, and its name must not be in the registry`);
  } else if (typeof entry.name !== 'string' || !entry.name) {
    throw bad(`workspace ${entry.id} has no name`);
  }
  const extra = Object.keys(entry).filter((k) => !['id', 'path', 'custody', 'createdAt', 'name'].includes(k));
  if (extra.length) throw bad(`workspace ${entry.id} has unexpected fields: ${extra.join(', ')}`);
  return entry as RegistryEntry;
}

function checkAll(entries: RegistryEntry[], where: string): void {
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) throw new RegistryError(`${where}: workspace ${e.id} is listed twice`);
    ids.add(e.id);
  }
}

/** The registered workspaces; an empty list when the file does not exist yet. */
export function readRegistry(file: string): RegistryEntry[] {
  if (!existsSync(file)) return [];
  let parsed: RegistryFile;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new RegistryError(`the workspace registry at ${file} cannot be read; it has been left as it is`, { cause: err });
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.workspaces)) {
    throw new RegistryError(`the workspace registry at ${file} is not a registry; it has been left as it is`);
  }
  if (parsed.format !== REGISTRY_FORMAT) {
    throw new RegistryError(`the workspace registry at ${file} has format ${String(parsed.format)}; this version of MCP Explorer reads format ${REGISTRY_FORMAT}`);
  }
  const entries = parsed.workspaces.map((e, i) => checkEntry(e, `${file} entry ${i}`));
  checkAll(entries, file);
  return entries;
}

/**
 * Replaces the registry. Written to a temporary file beside the target,
 * flushed, then renamed over it, so a crash leaves either the old registry or
 * the new one, never half of either.
 */
export function writeRegistry(file: string, entries: RegistryEntry[]): void {
  const checked = entries.map((e, i) => checkEntry(e, `new registry entry ${i}`));
  checkAll(checked, 'new registry');
  const body = JSON.stringify({ format: REGISTRY_FORMAT, workspaces: checked } satisfies RegistryFile, null, 2) + '\n';
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = openSync(temp, 'wx');
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

export function addToRegistry(file: string, entry: RegistryEntry): void {
  const entries = readRegistry(file);
  if (entries.some((e) => e.id === entry.id)) throw new RegistryError(`workspace ${entry.id} is already registered`);
  writeRegistry(file, [...entries, entry]);
}

/** True when the workspace was registered. Removes the entry only; the database file is untouched. */
export function removeFromRegistry(file: string, id: string): boolean {
  const entries = readRegistry(file);
  const kept = entries.filter((e) => e.id !== id);
  if (kept.length === entries.length) return false;
  writeRegistry(file, kept);
  return true;
}

export function renameInRegistry(file: string, id: string, name: string): void {
  const entries = readRegistry(file);
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new RegistryError(`workspace ${id} is not registered`);
  if (entry.custody === 'passphrase') {
    throw new RegistryError(`workspace ${id} is passphrase-protected; its name is stored inside its database, not in the registry`);
  }
  writeRegistry(file, entries.map((e) => (e.id === id ? { ...e, name } : e)));
}

/** What the picker shows before a workspace is unlocked (D29). */
export function registryLabel(entry: RegistryEntry): string {
  if (entry.name !== undefined) return entry.name;
  // The user's local calendar date: a workspace created in the evening must not
  // read as created tomorrow because the date was taken in UTC.
  const d = new Date(entry.createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Protected workspace, created ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
