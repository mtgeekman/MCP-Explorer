// Reading other clients' MCP config files (phase 05; plan decisions 2 and
// 9-11). Pure: text in, draft servers out. Nothing here reads a file, runs a
// command or looks at the app's environment; which files exist is the
// platform layer's question, and what gets saved is the user's, in the review.
//
// A format the parser does not understand is refused with a message, never
// guessed at: an entry it cannot import faithfully is disabled with its
// reason, and every field it leaves out is listed.
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import type { Transport } from '../../storage/dist/index.js';

export type ImportClient = 'claude-desktop' | 'claude-code' | 'vscode' | 'cursor';

/**
 * Where a file keeps its servers (formats researched 2026-09-25, recorded on
 * the plan page):
 * - `mcpServers`: a top-level `mcpServers` map. Claude Desktop, Cursor, Claude
 *   Code's `.mcp.json` and `managed-mcp.json`, VS Code's portable files.
 * - `claude-code-user`: `~/.claude.json`, whose top-level `mcpServers` is the
 *   user scope and whose `projects[<path>].mcpServers` are local scopes.
 * - `vscode`: VS Code's `mcp.json`, a top-level `servers` map.
 * - `vscode-settings`: VS Code's `settings.json` before 1.102, `mcp.servers`.
 * - `devcontainer`: `devcontainer.json`, `customizations.vscode.mcp.servers`.
 */
export type ConfigFormat = 'mcpServers' | 'claude-code-user' | 'vscode' | 'vscode-settings' | 'devcontainer';

export interface ConfigSource {
  client: ImportClient;
  format: ConfigFormat;
  /** The project a project-scope file belongs to; resolves `${workspaceFolder}`. */
  projectRoot?: string;
  /** The user's home directory; resolves `${userHome}`. */
  home: string;
  /** The path separator; resolves `${/}` and `${pathSeparator}`. */
  sep: '/' | '\\';
}

/** A server as the file describes it, ready for the review. Nothing is saved yet. */
export interface DraftServer {
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  /** Values the file does not hold (a variable the app will not fill): asked for at connect. */
  askFor: { env: string[]; headers: string[] };
  /** Plain values whose names look like credentials: the review pre-marks them as secrets (decision 2). */
  suggestedSecrets: { env: string[]; headers: string[] };
}

export interface ImportEntry {
  /** The entry's key in the file. */
  name: string;
  /** Where in the file it sits, e.g. `mcpServers` or `projects["/src/app"].mcpServers`. */
  location: string;
  /** The project a local-scope entry belongs to. */
  projectRoot?: string;
  /** Absent when the entry cannot be imported; `disabled` says why. */
  server?: DraftServer;
  disabled?: string;
  /** Fields left out, each with why. */
  dropped: string[];
  /** What the import did that the user should know, e.g. a value to be asked for. */
  notes: string[];
  /** The entry as the file has it, for the review to show. */
  raw: string;
}

export interface ParsedConfig {
  entries: ImportEntry[];
  /** Why the file, or a part of it, could not be read. A corrupt file has no entries and one problem. */
  problems: string[];
}

export function parseConfig(text: string, source: ConfigSource): ParsedConfig {
  const errors: ParseError[] = [];
  const root: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false });
  if (errors.length) {
    const { line, column } = position(text, errors[0].offset);
    return { entries: [], problems: [`The file is not valid JSON: ${describeError(errors[0])} at line ${line}, column ${column}.`] };
  }
  if (!isObject(root)) return { entries: [], problems: ['The file does not hold a JSON object.'] };

  const problems: string[] = [];
  const entries: ImportEntry[] = [];
  for (const group of groups(root, source.format, problems)) {
    if (!isObject(group.servers)) {
      problems.push(`${group.location} is not an object of servers.`);
      continue;
    }
    for (const [name, value] of Object.entries(group.servers)) {
      entries.push(readEntry(name, value, group.location, { ...source, projectRoot: group.projectRoot ?? source.projectRoot }));
    }
  }
  return { entries, problems };
}

/** Whether a variable or header name looks like it holds a credential (decision 2). The user can override each. */
export function looksSecret(name: string): boolean {
  return /token|key|secret|passw(or)?d|auth|credential/i.test(name);
}

interface Group {
  location: string;
  servers: unknown;
  projectRoot?: string;
}

function groups(root: Record<string, unknown>, format: ConfigFormat, problems: string[]): Group[] {
  switch (format) {
    case 'mcpServers':
      return root.mcpServers === undefined ? [] : [{ location: 'mcpServers', servers: root.mcpServers }];
    case 'claude-code-user': {
      const out: Group[] = root.mcpServers === undefined ? [] : [{ location: 'mcpServers', servers: root.mcpServers }];
      if (root.projects === undefined) return out;
      if (!isObject(root.projects)) {
        problems.push('projects is not an object.');
        return out;
      }
      for (const [path, project] of Object.entries(root.projects)) {
        if (isObject(project) && project.mcpServers !== undefined) {
          out.push({ location: `projects[${JSON.stringify(path)}].mcpServers`, servers: project.mcpServers, projectRoot: path });
        }
      }
      return out;
    }
    case 'vscode':
      return root.servers === undefined ? [] : [{ location: 'servers', servers: root.servers }];
    case 'vscode-settings': {
      const mcp = root.mcp;
      return isObject(mcp) && mcp.servers !== undefined ? [{ location: 'mcp.servers', servers: mcp.servers }] : [];
    }
    case 'devcontainer': {
      const servers = dig(root, ['customizations', 'vscode', 'mcp', 'servers']);
      return servers === undefined ? [] : [{ location: 'customizations.vscode.mcp.servers', servers }];
    }
  }
}

const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd']);
const REMOTE_FIELDS = new Set(['type', 'url', 'headers']);

/** Why a known field is left out (decision 10). Any other field is left out as unknown. */
const DROPPED: Record<string, string> = {
  envFile: 'an environment file; its variables are not read, so add any the server needs by hand',
  headersHelper: 'a command that produces headers; it is not run, so add the headers by hand or as secrets',
  oauth: 'OAuth settings; OAuth is not supported yet',
  auth: 'OAuth settings; OAuth is not supported yet',
  timeout: "the client's own timeout",
  disabled: "the client's own on/off switch",
  alwaysLoad: "a Claude Code loading option",
  dev: 'VS Code development options',
  sandboxEnabled: 'a VS Code sandbox option',
};

function readEntry(name: string, value: unknown, location: string, ctx: ConfigSource): ImportEntry {
  const entry: ImportEntry = { name, location, ...(ctx.projectRoot ? { projectRoot: ctx.projectRoot } : {}), dropped: [], notes: [], raw: JSON.stringify(value, null, 2) ?? String(value) };
  const disable = (why: string): ImportEntry => ({ ...entry, disabled: why });
  if (!name.trim()) return disable('The entry has no name.');
  if (!isObject(value)) return disable('The entry is not an object.');

  const transport = transportOf(value, ctx.client);
  if ('refused' in transport) return disable(transport.refused);
  const stdio = transport.transport === 'stdio';

  for (const field of Object.keys(value)) {
    if ((stdio ? STDIO_FIELDS : REMOTE_FIELDS).has(field)) continue;
    const why = (stdio ? REMOTE_FIELDS : STDIO_FIELDS).has(field)
      ? `has no effect on a ${stdio ? 'local' : 'remote'} server`
      : DROPPED[field] ?? 'not something this app uses';
    entry.dropped.push(`${field}: ${why}`);
  }

  const server: DraftServer = { name: name.trim(), transport: transport.transport, env: {}, headers: {}, askFor: { env: [], headers: [] }, suggestedSecrets: { env: [], headers: [] } };

  // A location field with a value the app will not fill cannot become a secret: refuse the entry.
  const located = (field: string, text: string): string | { refused: string } => {
    const r = substitute(text, ctx);
    return 'unresolved' in r ? { refused: `${field} uses ${r.unresolved}, which the app does not fill in.` } : r.value;
  };

  if (stdio) {
    if (typeof value.command !== 'string' || !value.command.trim()) return disable('"command" is missing or not text.');
    const command = located('The command', value.command);
    if (typeof command !== 'string') return disable(command.refused);
    server.command = command;
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || !value.args.every((a) => typeof a === 'string')) return disable('"args" is not a list of text values.');
      const args: string[] = [];
      for (const [i, a] of value.args.entries()) {
        const arg = located(`Argument ${i + 1}`, a);
        if (typeof arg !== 'string') return disable(arg.refused);
        args.push(arg);
      }
      server.args = args;
    }
    if (value.cwd !== undefined) {
      if (typeof value.cwd !== 'string') return disable('"cwd" is not text.');
      const cwd = located('The working directory', value.cwd);
      if (typeof cwd !== 'string') return disable(cwd.refused);
      if (cwd) server.cwd = cwd;
    }
  } else {
    if (typeof value.url !== 'string' || !value.url.trim()) return disable('"url" is missing or not text.');
    const url = located('The url', value.url);
    if (typeof url !== 'string') return disable(url.refused);
    server.url = url;
  }

  const map = stdio ? value.env : value.headers;
  const kind = stdio ? 'env' : 'headers';
  const what = stdio ? 'environment variable' : 'header';
  if (map !== undefined) {
    if (!isObject(map)) return disable(`"${stdio ? 'env' : 'headers'}" is not an object.`);
    for (const [key, raw] of Object.entries(map)) {
      if (typeof raw !== 'string') return disable(`${what} ${key} is not text.`);
      const r = substitute(raw, ctx);
      if ('unresolved' in r) {
        // Decision 9: never filled from the app's own environment. The value
        // is asked for at connect and held for the session (D31, amended).
        server.askFor[kind].push(key);
        entry.notes.push(`${what[0].toUpperCase()}${what.slice(1)} ${key} comes from ${r.unresolved}; you will be asked for its value when you connect.`);
      } else {
        server[kind][key] = r.value;
        if (looksSecret(key)) server.suggestedSecrets[kind].push(key);
      }
    }
  }
  return { ...entry, server };
}

function transportOf(value: Record<string, unknown>, client: ImportClient): { transport: Transport } | { refused: string } {
  const hasCommand = value.command !== undefined;
  const hasUrl = value.url !== undefined;
  if (hasCommand && hasUrl) return { refused: 'It has both a command and a url, so what it would run is unclear.' };
  const type = value.type;
  if (type !== undefined && typeof type !== 'string') return { refused: '"type" is not text.' };
  if (type === undefined) {
    if (hasCommand) return { transport: 'stdio' };
    if (!hasUrl) return { refused: 'It has neither a command nor a url.' };
    if (client === 'claude-desktop') return { refused: 'Claude Desktop runs only local commands from this file, and this entry has a url instead.' };
    if (client === 'claude-code') return { refused: 'Claude Code refuses a url without a "type", so it does not run this entry either.' };
    return { transport: 'streamable-http' };
  }
  switch (type) {
    case 'stdio':
      return hasUrl ? { refused: '"type" is stdio but the entry has a url.' } : { transport: 'stdio' };
    case 'http':
    case 'streamable-http':
      return hasCommand ? { refused: `"type" is ${type} but the entry has a command.` } : { transport: 'streamable-http' };
    case 'sse':
      return hasCommand ? { refused: '"type" is sse but the entry has a command.' } : { transport: 'sse' };
    case 'ws':
      return { refused: 'WebSocket ("type": "ws") is not an MCP transport this app speaks.' };
    case 'sdk':
      return { refused: 'An SDK server runs inside Claude Code and cannot be started from outside it.' };
    default:
      return { refused: `"type" is ${JSON.stringify(type)}, which this app does not know.` };
  }
}

/**
 * Fills in the variables whose values are certain (decision 9): the user's
 * home, the project folder when the file belongs to one, the path separator.
 * Anything else -- an environment variable, a VS Code input, a command -- is
 * reported, not filled, and never from the app's own environment.
 */
function substitute(text: string, ctx: ConfigSource): { value: string } | { unresolved: string } {
  if (ctx.client === 'claude-desktop') return { value: text };
  // One pattern for every client that has variables: a project .mcp.json is
  // shared by Claude Code and VS Code, so a Claude Code file can carry
  // ${workspaceFolder} or ${input:id}. Whatever is not known is reported,
  // never passed through as literal text.
  const pattern = /\$\{([^}]*)\}/g;
  let unresolved: string | undefined;
  const value = text.replace(pattern, (whole: string, name: string) => {
    const filled = known(name, ctx);
    if (filled === undefined) unresolved ??= whole;
    return filled ?? whole;
  });
  return unresolved === undefined ? { value } : { unresolved };
}

function known(name: string, ctx: ConfigSource): string | undefined {
  if (ctx.client === 'claude-code') return name === 'CLAUDE_PROJECT_DIR' ? ctx.projectRoot : undefined;
  switch (name) {
    case 'userHome': return ctx.home;
    case 'workspaceFolder': return ctx.projectRoot;
    case 'workspaceFolderBasename': return ctx.projectRoot === undefined ? undefined : basename(ctx.projectRoot);
    case '/':
    case 'pathSeparator': return ctx.sep;
    default: return undefined;
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function describeError(e: ParseError): string {
  const code = printParseErrorCode(e.error);
  return code.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function dig(v: unknown, path: string[]): unknown {
  let at = v;
  for (const key of path) {
    if (!isObject(at)) return undefined;
    at = at[key];
  }
  return at;
}
