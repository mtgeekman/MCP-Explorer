// The import review's decisions, DOM-free (board 3.3; phase 05 plan decisions
// 2 and 3). What the user sees is the files read and each entry's draft; what
// the user decides per entry is whether to keep it, under what name, what to
// do when that name is taken, and which plain values are secrets.
import type { ImportChoice, ReadConfig, ServerRow } from '../../../../packages/backend/dist/index.js';

export type OnClash = 'skip' | 'rename' | 'replace';

export interface EntryState {
  keep: boolean;
  name: string;
  onClash: OnClash;
  secretEnv: string[];
  secretHeaders: string[];
}

export type ReviewState = Record<string, EntryState>;

export const entryKey = (file: number, entry: number) => `${file}:${entry}`;

/** Every importable entry kept, under its own name, with credential-looking values marked secret (decision 2). */
export function initialState(files: ReadConfig[]): ReviewState {
  const state: ReviewState = {};
  files.forEach((f, i) => f.entries.forEach((e, j) => {
    if (!e.server) return;
    state[entryKey(i, j)] = {
      keep: true,
      name: e.server.name,
      // Decision 3: a taken name is skipped until the user says otherwise.
      onClash: 'skip',
      secretEnv: [...e.server.suggestedSecrets.env],
      secretHeaders: [...e.server.suggestedSecrets.headers],
    };
  }));
  return state;
}

export interface Clash {
  /** A saved server with this name. */
  existing?: { id: string; name: string };
  /** An earlier entry in this import that will be saved under this name. */
  entry?: string;
}

export interface Outcome {
  key: string;
  clash?: Clash;
  /** What happens to the entry on import. */
  result: 'save' | 'skip' | 'problem';
  replaceId?: string;
  problem?: string;
}

/** Keys of kept importable entries, in the order the review shows them. */
function keptKeys(files: ReadConfig[], state: ReviewState): string[] {
  return files.flatMap((f, i) => f.entries.map((_, j) => entryKey(i, j))).filter((k) => state[k]?.keep);
}

/**
 * Decides every kept entry in review order. A name belongs to a saved server,
 * or to the first entry in this import that will be saved under it; an entry
 * that is skipped claims nothing, so it never blocks a later one.
 */
export function outcomes(files: ReadConfig[], state: ReviewState, existing: Pick<ServerRow, 'id' | 'name'>[]): Map<string, Outcome> {
  const out = new Map<string, Outcome>();
  const claimed = new Map<string, string>();
  for (const key of keptKeys(files, state)) {
    const s = state[key];
    const name = s.name.trim();
    if (!name) {
      out.set(key, { key, result: 'problem', problem: 'It has no name.' });
      continue;
    }
    const saved = existing.find((x) => x.name === name);
    const earlier = claimed.get(name);
    const clash: Clash | undefined = saved || earlier
      ? { ...(saved ? { existing: { id: saved.id, name: saved.name } } : {}), ...(earlier ? { entry: earlier } : {}) }
      : undefined;
    let o: Outcome = { key, result: 'save' };
    if (clash) {
      if (s.onClash === 'skip') o = { key, clash, result: 'skip' };
      else if (s.onClash === 'rename') o = { key, clash, result: 'problem', problem: `${name} is still taken; choose another name.` };
      else if (clash.entry) o = { key, clash, result: 'problem', problem: `${name} is also the name of another server in this import; only a saved server can be replaced.` };
      else o = { key, clash, result: 'save', replaceId: clash.existing!.id };
    }
    if (o.result === 'save') claimed.set(name, key);
    out.set(key, o);
  }
  return out;
}

export interface Plan {
  choices: ImportChoice[];
  /** Kept entries left out because their name is taken and the user chose to skip. */
  skipped: string[];
  /** What stops the import as it stands. */
  problems: string[];
}

/** The servers to send to import.save, or the problems that stop it. */
export function plan(files: ReadConfig[], state: ReviewState, existing: Pick<ServerRow, 'id' | 'name'>[]): Plan {
  const out: Plan = { choices: [], skipped: [], problems: [] };
  for (const o of outcomes(files, state, existing).values()) {
    const [i, j] = o.key.split(':').map(Number);
    const server = files[i].entries[j].server!;
    const s = state[o.key];
    if (o.result === 'skip') out.skipped.push(s.name.trim());
    if (o.result === 'problem') out.problems.push(`${files[i].entries[j].name} (${files[i].location.label}): ${o.problem}`);
    if (o.result !== 'save') continue;
    out.choices.push({
      draft: server,
      name: s.name.trim(),
      ...(o.replaceId ? { replaceId: o.replaceId } : {}),
      secrets: { env: s.secretEnv.filter((k) => Object.hasOwn(server.env, k)), headers: s.secretHeaders.filter((k) => Object.hasOwn(server.headers, k)) },
    });
  }
  return out;
}

/** Toggles one name in a list, keeping order. */
export function toggle(list: string[], name: string, on: boolean): string[] {
  return on ? (list.includes(name) ? list : [...list, name]) : list.filter((n) => n !== name);
}

/** Sources an importer cannot see, named so an import never reads as complete when it is not (decision 12). */
export const OUT_OF_REACH = [
  'Claude Desktop connectors and extensions, set up in its Settings',
  'claude.ai connectors used by Claude Code',
  'Cursor team servers, managed in its dashboard',
  'Values VS Code keeps for its inputs, in its own secure storage',
];
