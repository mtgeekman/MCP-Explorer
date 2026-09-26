// Two versions of one server's surface, compared every way the version view
// shows them (plan phase 09): by item down to the field, as the model sees
// them, by token cost, and as stored.
import { canonicalSurface } from './canonical.js';
import { buildContext, costContext, renderContext, type ContextServer } from './context.js';
import { diffSurfaces, type ChangeKind, type SurfaceDiff } from './diff.js';
import type { NormalizedSurface } from './model.js';
import { diffText, type TextDiff } from './textdiff.js';
import type { Tokenizer } from './tokens.js';

export interface TextComparison {
  before: string;
  after: string;
  diff: TextDiff;
}

export interface ToolTokenDelta {
  name: string;
  kind: ChangeKind;
  /** Absent on an added tool. */
  before?: number;
  /** Absent on a removed tool. */
  after?: number;
  delta: number;
}

export interface TokenDelta {
  tokenizer: { id: string; label: string };
  before: number;
  after: number;
  delta: number;
  /** The instructions section's cost before and after, heading included. */
  instructions: { before: number; after: number };
  /** Tools whose cost changed, added or removed, largest change first; ties by name. */
  tools: ToolTokenDelta[];
}

export interface VersionComparison {
  structured: SurfaceDiff;
  /** The phase 06 block for this one server, before and after (decision 4). */
  model: TextComparison;
  tokens: TokenDelta;
  /** Each snapshot's canonical JSON as stored, before and after (decision 6). */
  raw: TextComparison;
}

/**
 * `name` is the workspace's name for the server: the block's instructions
 * heading uses it, as the context preview does.
 */
export function compareVersions(
  before: NormalizedSurface,
  after: NormalizedSurface,
  options: { name: string; tokenizer: Tokenizer; maxEdits?: number },
): VersionComparison {
  const server = (surface: NormalizedSurface): ContextServer[] => [{ id: 'server', name: options.name, surface }];
  const text = (a: string, b: string): TextComparison => ({ before: a, after: b, diff: diffText(a, b, { maxEdits: options.maxEdits }) });
  return {
    structured: diffSurfaces(before, after),
    model: text(renderContext(buildContext(server(before))), renderContext(buildContext(server(after)))),
    tokens: tokenDelta(server(before), server(after), options.tokenizer),
    raw: text(JSON.stringify(canonicalSurface(before), null, 2), JSON.stringify(canonicalSurface(after), null, 2)),
  };
}

function tokenDelta(before: ContextServer[], after: ContextServer[], tokenizer: Tokenizer): TokenDelta {
  const a = costContext(before, tokenizer);
  const b = costContext(after, tokenizer);
  // A name a server repeats is a capture problem reported there; its costs add up here.
  const byName = (tools: { name: string; tokens: number }[]) => {
    const out = new Map<string, number>();
    for (const t of tools) out.set(t.name, (out.get(t.name) ?? 0) + t.tokens);
    return out;
  };
  const ta = byName(a.tools);
  const tb = byName(b.tools);
  const tools: ToolTokenDelta[] = [];
  for (const [name, cost] of ta) {
    const next = tb.get(name);
    if (next === undefined) tools.push({ name, kind: 'removed', before: cost, delta: -cost });
    else if (next !== cost) tools.push({ name, kind: 'changed', before: cost, after: next, delta: next - cost });
  }
  for (const [name, cost] of tb) {
    if (!ta.has(name)) tools.push({ name, kind: 'added', after: cost, delta: cost });
  }
  tools.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  // The shared heading is part of the instructions a server brings, when it brings any.
  const instructions = (c: typeof a) => c.shared + (c.servers[0]?.instructions ?? 0);
  return {
    tokenizer: a.tokenizer,
    before: a.total,
    after: b.total,
    delta: b.total - a.total,
    instructions: { before: instructions(a), after: instructions(b) },
    tools,
  };
}
