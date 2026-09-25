// Token counting for the cost view (plan phase 06, decision 1).
//
// One tokenizer behind one interface, so changing it is one module. The count
// is o200k_base, exact for OpenAI's GPT-4o and later families and an
// approximation for everything else: no current Claude tokenizer is published,
// and asking a provider's API to count is ruled out (no model provider in the
// product). The label travels with every number so it is never read as
// universal.
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

export interface Tokenizer {
  /** Stable identifier, stored nowhere yet but shown with every count. */
  id: string;
  /** What the user is told the number means. */
  label: string;
  count(text: string): number;
}

// Server text is untrusted. A description containing `<|endoftext|>` is
// ordinary text to a model's API, and the encoder's default is to throw on it,
// which would let one hostile tool break the whole view. Nothing is special.
const NOTHING_SPECIAL = { disallowedSpecial: new Set<string>() };

export const O200K: Tokenizer = {
  id: 'o200k_base',
  label: 'o200k_base tokens (OpenAI GPT-4o and later); Claude and other model families count differently',
  count: (text) => countTokens(text, NOTHING_SPECIAL),
};
