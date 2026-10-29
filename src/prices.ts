import type { Usage } from "./usage.js";

/** Prices in USD per one million tokens. */
export interface Price {
  input: number;
  output: number;
  /** Reading cached input (defaults to `input`). */
  cachedInput?: number;
  /** Writing to the prompt cache (defaults to `input`). */
  cacheWrite?: number;
}

/** Keys are model ids or globs: `"gpt-4o-mini"`, `"claude-*-haiku*"`, `"gemini-2.*-flash"`. */
export type PriceTable = Record<string, Price>;

function globToRegExp(glob: string): RegExp {
  return new RegExp("^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
}

/** Exact id first; then dated versions (`gpt-4o-mini-2024-07-18` → `gpt-4o-mini`); then the most specific glob. */
export function findPrice(table: PriceTable, model: string): Price | undefined {
  if (table[model]) return table[model];
  const lower = model.toLowerCase();
  const prefixes = Object.keys(table).filter((k) => !k.includes("*") && lower.startsWith(k.toLowerCase() + "-")).sort((a, b) => b.length - a.length);
  if (prefixes.length) return table[prefixes[0]];
  const globs = Object.keys(table).filter((k) => k.includes("*") && globToRegExp(k).test(model)).sort((a, b) => b.replace(/\*/g, "").length - a.replace(/\*/g, "").length);
  return globs.length ? table[globs[0]] : undefined;
}

export function costOf(usage: Usage, price: Price): number {
  return (
    usage.inputTokens * price.input +
    usage.cachedInputTokens * (price.cachedInput ?? price.input) +
    usage.cacheWriteTokens * (price.cacheWrite ?? price.input) +
    usage.outputTokens * price.output
  ) / 1_000_000;
}
