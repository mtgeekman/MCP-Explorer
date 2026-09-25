// Config import's file and storage half (phase 05). Every step is one the user
// took: listing looks only at whether known files exist, reading reads only
// the files the user picked, and saving saves only the servers the user kept
// (plan decision 1). Nothing is run: an imported server starts when the user
// connects to it.
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { sep } from 'node:path';
import { projectConfigLocations, userConfigLocations, type ConfigLocation } from '../../platform/dist/index.js';
import { clearEra, loadServer, saveServer, type ServerDefinition, type Workspace } from '../../storage/dist/index.js';
import { parseConfig, type DraftServer, type ImportEntry } from './config-import.js';

/** Larger than any config file; a file this big is not one, and is not read into memory. */
const MAX_CONFIG_BYTES = 20 * 1024 * 1024;

export interface FoundLocation extends ConfigLocation {
  found: boolean;
  /** Why a path that may exist could not be checked, e.g. EACCES. Absent for a plain "not there". */
  unreadable?: string;
}

export interface ReadConfig {
  location: ConfigLocation;
  entries: ImportEntry[];
  problems: string[];
}

/** A server the user kept in the review, with the plain values they marked as secrets. */
export interface ImportChoice {
  draft: DraftServer;
  /** The name to save it under: the draft's, or the user's rename. */
  name: string;
  /** An existing server this one replaces, when the user chose to. */
  replaceId?: string;
  secrets: { env: string[]; headers: string[] };
}

/** The user's config files, and those of any project folders the user chose, each marked found or not. */
export async function listConfigLocations(projectRoots: string[] = []): Promise<FoundLocation[]> {
  const locations = [
    ...userConfigLocations({ platform: process.platform, home: homedir(), env: process.env }),
    ...projectRoots.flatMap((root) => projectConfigLocations(root, process.platform)),
  ];
  return Promise.all(locations.map(async (l) => ({ ...l, ...(await probe(l.path)) })));
}

/** Reads and parses the files the user picked. A file that cannot be read is a problem, never a crash. */
export async function readConfigs(locations: ConfigLocation[]): Promise<ReadConfig[]> {
  return Promise.all(locations.map(async (location): Promise<ReadConfig> => {
    let text: string;
    try {
      const s = await stat(location.path);
      if (!s.isFile()) return { location, entries: [], problems: ['This is not a file.'] };
      if (s.size > MAX_CONFIG_BYTES) return { location, entries: [], problems: [`The file is ${s.size} bytes, too large to be a config file; it was not read.`] };
      text = await readFile(location.path, 'utf8');
    } catch (e) {
      return { location, entries: [], problems: [`The file could not be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}.`] };
    }
    const parsed = parseConfig(text, { client: location.client, format: location.layout, projectRoot: location.projectRoot, home: homedir(), sep: sep as '/' | '\\' });
    return { location, ...parsed };
  }));
}

/**
 * Saves the servers the user kept, all or none. A plain value the user
 * marked as a secret is stored as one in an encrypted workspace; in an
 * unencrypted one only its name is kept and its value is dropped (D31), as
 * the review said before the user confirmed. A value the file did not hold
 * is asked for at connect in both.
 */
export function saveImported(ws: Workspace, choices: ImportChoice[], now?: () => number): string[] {
  const defs = choices.map((c) => toDefinition(c, ws.encrypted));
  ws.db.transaction(() => {
    for (const [i, def] of defs.entries()) {
      if (choices[i].replaceId) {
        if (!loadServer(ws, def.id)) throw new ImportError(`the server ${choices[i].name} was to replace no longer exists`);
        // A replacement is a different server: its era is detected afresh (D20).
        clearEra(ws, def.id);
      }
      saveServer(ws, def, now);
    }
  })();
  return defs.map((d) => d.id);
}

/** The review sent something the import cannot save as it stands. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

function toDefinition(c: ImportChoice, encrypted: boolean): ServerDefinition {
  const d = c.draft;
  const name = c.name.trim();
  if (!name) throw new ImportError('an imported server needs a name');
  const split = (values: Record<string, string>, marked: string[], what: string) => {
    for (const key of marked) if (!Object.hasOwn(values, key)) throw new ImportError(`${name}: ${what} ${key} was marked secret but has no value in the file`);
    const plain = Object.fromEntries(Object.entries(values).filter(([k]) => !marked.includes(k)));
    const secret = Object.fromEntries(Object.entries(values).filter(([k]) => marked.includes(k)));
    return { plain, secret };
  };
  const env = split(d.env, c.secrets.env, 'environment variable');
  const headers = split(d.headers, c.secrets.headers, 'header');
  const nonEmpty = <T extends object>(o: T) => (Object.keys(o).length ? o : undefined);
  const def: ServerDefinition = {
    id: c.replaceId ?? randomUUID(),
    name,
    transport: d.transport,
    ...(d.command !== undefined ? { command: d.command } : {}),
    ...(d.args !== undefined ? { args: d.args } : {}),
    ...(d.cwd !== undefined ? { cwd: d.cwd } : {}),
    ...(d.url !== undefined ? { url: d.url } : {}),
  };
  if (nonEmpty(env.plain)) def.env = env.plain;
  if (nonEmpty(headers.plain)) def.headers = headers.plain;
  const unstored = {
    env: [...d.askFor.env, ...(encrypted ? [] : Object.keys(env.secret))],
    headers: [...d.askFor.headers, ...(encrypted ? [] : Object.keys(headers.secret))],
  };
  if (encrypted) {
    if (nonEmpty(env.secret)) def.secretEnv = env.secret;
    if (nonEmpty(headers.secret)) def.secretHeaders = headers.secret;
  }
  if (unstored.env.length || unstored.headers.length) {
    def.unstoredSecrets = { ...(unstored.env.length ? { env: unstored.env } : {}), ...(unstored.headers.length ? { headers: unstored.headers } : {}) };
  }
  return def;
}

async function probe(path: string): Promise<{ found: boolean; unreadable?: string }> {
  try {
    return { found: (await stat(path)).isFile() };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Not there is the common case; anything else is shown, not swallowed.
    return code === 'ENOENT' || code === 'ENOTDIR' ? { found: false } : { found: false, unreadable: code ?? (e as Error).message };
  }
}
