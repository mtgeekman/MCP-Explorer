// The context screen's DOM-free parts (phase 06).
import type { ContextCost, ToolCost } from '../../../../packages/protocol/dist/context.js';

/** The n most expensive tools, each with its share of the whole block. */
export function worstOffenders(cost: ContextCost, n: number): (ToolCost & { share: string })[] {
  return cost.tools.slice(0, n).map((t) => ({
    ...t,
    share: cost.total === 0 ? '' : `${((t.tokens / cost.total) * 100).toFixed(1)}%`,
  }));
}
