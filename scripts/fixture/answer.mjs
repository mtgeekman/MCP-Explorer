// Each front's one entry point for an era: the phase 07 calls, the era's
// handler, and the phase 10 extras over both.
import { answerer } from './call-handler.mjs';
import { withExtras } from './extras.mjs';
import { handleLegacy } from './legacy-handler.mjs';
import { handleModern, serverMeta } from './modern-handler.mjs';

/** Resolves to the response for `msg`, or undefined, DIE or SILENT. `send` writes a message ahead of it. */
export function eraAnswerer(era) {
  const extra = era === 'legacy' ? () => ({}) : () => ({ resultType: 'complete', ...serverMeta() });
  return withExtras(answerer(era === 'legacy' ? handleLegacy : handleModern, extra), era, extra);
}
