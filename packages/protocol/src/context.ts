// The context preview (plan phase 06; spec D3): the block a client hands a
// model, built from captured surfaces across a workspace's servers.
//
// The shape is the Anthropic Messages API's (decision 2, 2026-09-25): a system
// text carrying each server's instructions, and `tools` as
// `{name, description, input_schema}`. No MCP client library produces a model
// block, so this is the one documented target, pinned by a golden file. How a
// particular client words the system text around the instructions is its own
// choice; the heading lines here are this app's, and say so in the UI.
//
// Prompts and resources are not part of the block: clients offer them to the
// user, not to the model, until someone picks one.
import type { NormalizedSurface } from './model.js';
import type { Tokenizer } from './tokens.js';

export interface ContextServer {
  id: string;
  name: string;
  surface: NormalizedSurface;
}

/** One entry of the Messages API `tools` array. */
export interface ContextTool {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export interface ContextBlock {
  system: string;
  tools: ContextTool[];
}

export const INSTRUCTIONS_HEADING = '# MCP server instructions';

function toolEntry(tool: NormalizedSurface['tools'][number]): ContextTool {
  // Key order is the API's documented order. An absent description or schema
  // stays absent: what the server did not send is not invented here.
  const entry: ContextTool = { name: tool.name };
  if (tool.description !== undefined) entry.description = tool.description;
  if (tool.inputSchema !== undefined) entry.input_schema = tool.inputSchema;
  return entry;
}

function byName<T extends { name: string }>(tools: T[]): T[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function instructionsSection(server: ContextServer): string | undefined {
  const text = server.surface.instructions;
  return text === undefined || text === '' ? undefined : `## ${server.name}\n\n${text}`;
}

/**
 * The block for the given servers, in the order given; each server's tools
 * sorted by name. A client sends tools in the order the server listed them,
 * but a server may shuffle that order on every list (the fixture does), and a
 * block that moved with it would show a change in every version diff where
 * the surface hash saw none. An agent sees one namespace, so tools are not
 * renamed or prefixed: a name two servers share appears twice, and
 * `collisions` reports it.
 */
export function buildContext(servers: ContextServer[]): ContextBlock {
  const sections = servers.map(instructionsSection).filter((s): s is string => s !== undefined);
  return {
    system: sections.length === 0 ? '' : [INSTRUCTIONS_HEADING, ...sections].join('\n\n'),
    tools: servers.flatMap((s) => byName(s.surface.tools).map(toolEntry)),
  };
}

/** The block as the preview shows it: two-space JSON, readable, the same values. */
export function renderContext(block: ContextBlock): string {
  return JSON.stringify(block, null, 2);
}

export interface ToolCost {
  serverId: string;
  name: string;
  tokens: number;
}

export interface ServerCost {
  serverId: string;
  /** Its instructions section, heading included; 0 without instructions. */
  instructions: number;
  tools: number;
  total: number;
}

export interface Collision {
  name: string;
  /** Every server listing a tool of this name, in block order. */
  serverIds: string[];
}

export interface ContextCost {
  tokenizer: { id: string; label: string };
  /** The heading the system text opens with, counted once; 0 when no server has instructions. */
  shared: number;
  total: number;
  servers: ServerCost[];
  /** Every tool, most expensive first; ties keep block order. */
  tools: ToolCost[];
  collisions: Collision[];
}

/**
 * Counts as a client would send it: each tool as compact JSON, and each
 * instructions section as text. The total is the sum of the parts shown, so
 * every number on screen adds up; one tokenizer run over the whole request
 * body would differ by the few tokens at the joins between parts.
 */
export function costContext(servers: ContextServer[], tokenizer: Tokenizer): ContextCost {
  const tools: ToolCost[] = [];
  const perServer: ServerCost[] = servers.map((server) => {
    const section = instructionsSection(server);
    const instructions = section === undefined ? 0 : tokenizer.count(section);
    let toolTokens = 0;
    for (const tool of byName(server.surface.tools)) {
      const tokens = tokenizer.count(JSON.stringify(toolEntry(tool)));
      tools.push({ serverId: server.id, name: tool.name, tokens });
      toolTokens += tokens;
    }
    return { serverId: server.id, instructions, tools: toolTokens, total: instructions + toolTokens };
  });
  const shared = perServer.some((s) => s.instructions > 0) ? tokenizer.count(INSTRUCTIONS_HEADING) : 0;
  return {
    tokenizer: { id: tokenizer.id, label: tokenizer.label },
    shared,
    total: perServer.reduce((n, s) => n + s.total, shared),
    servers: perServer,
    tools: tools.map((t, i) => ({ t, i })).sort((a, b) => b.t.tokens - a.t.tokens || a.i - b.i).map(({ t }) => t),
    collisions: findCollisions(servers),
  };
}

/**
 * Tool names more than one server lists. Within one server a repeated name is
 * a capture problem, reported there; here only a name crossing servers counts.
 */
export function findCollisions(servers: ContextServer[]): Collision[] {
  const byName = new Map<string, string[]>();
  for (const server of servers) {
    for (const tool of server.surface.tools) {
      const ids = byName.get(tool.name) ?? [];
      if (!ids.includes(server.id)) ids.push(server.id);
      byName.set(tool.name, ids);
    }
  }
  return [...byName].filter(([, ids]) => ids.length > 1)
    .map(([name, serverIds]) => ({ name, serverIds }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
