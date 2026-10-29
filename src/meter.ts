import { costOf, findPrice, type PriceTable } from "./prices.js";
import { parseUsage, type Usage } from "./usage.js";

export interface Context {
  user?: string;
  feature?: string;
  /** Overrides the model id found in the response. */
  model?: string;
  tags?: Record<string, string>;
}

export interface Entry {
  at: number;
  model: string;
  user?: string;
  feature?: string;
  tags?: Record<string, string>;
  usage: Usage;
  /** USD; null when the model has no price. */
  cost: number | null;
}

export interface Query {
  since?: number;
  until?: number;
  user?: string;
  feature?: string;
  model?: string;
}

/** Where entries live. Implement it over Redis, SQL or anything else; methods may be sync or async. */
export interface Store {
  add(entry: Entry): void | Promise<void>;
  query(q: Query): Entry[] | Promise<Entry[]>;
}

export class MemoryStore implements Store {
  readonly entries: Entry[] = [];
  constructor(private readonly maxAgeMs = 40 * 24 * 3600 * 1000) {}

  add(entry: Entry): void {
    this.entries.push(entry);
    const cutoff = entry.at - this.maxAgeMs;
    while (this.entries.length && this.entries[0].at < cutoff) this.entries.shift();
  }

  query(q: Query): Entry[] {
    return this.entries.filter(
      (e) =>
        (q.since === undefined || e.at >= q.since) &&
        (q.until === undefined || e.at < q.until) &&
        (q.user === undefined || e.user === q.user) &&
        (q.feature === undefined || e.feature === q.feature) &&
        (q.model === undefined || e.model === q.model),
    );
  }
}

export interface Totals {
  cost: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  unpricedCalls: number;
}

export interface MeterOptions {
  prices: PriceTable;
  store?: Store;
  now?: () => number;
  /** Called once per unknown model id. */
  onUnknownModel?: (model: string) => void;
  /** Throw on unknown models instead of recording a null cost. */
  strict?: boolean;
}

export class Meter {
  readonly store: Store;
  readonly now: () => number;
  private readonly warned = new Set<string>();

  constructor(private readonly opts: MeterOptions) {
    this.store = opts.store ?? new MemoryStore();
    this.now = opts.now ?? Date.now;
  }

  /** Cost in USD of a hypothetical call (for pre-flight checks). */
  estimate(model: string, inputTokens: number, outputTokens: number): number | null {
    const price = findPrice(this.opts.prices, model);
    return price ? costOf({ inputTokens, outputTokens, cachedInputTokens: 0, cacheWriteTokens: 0 }, price) : null;
  }

  /** Records a provider response (or a Usage object) and returns the entry with its cost. */
  async record(responseOrUsage: unknown, ctx: Context = {}): Promise<Entry> {
    const usage = isUsage(responseOrUsage) ? responseOrUsage : parseUsage(responseOrUsage);
    if (!usage) throw new TypeError("spendcap: no token usage found in the response");
    const model = ctx.model ?? usage.model ?? "unknown";
    const price = findPrice(this.opts.prices, model);
    if (!price) {
      if (this.opts.strict) throw new Error(`spendcap: no price for model "${model}"`);
      if (!this.warned.has(model)) {
        this.warned.add(model);
        this.opts.onUnknownModel?.(model);
      }
    }
    const entry: Entry = { at: this.now(), model, user: ctx.user, feature: ctx.feature, tags: ctx.tags, usage, cost: price ? costOf(usage, price) : null };
    await this.store.add(entry);
    return entry;
  }

  async totals(q: Query = {}): Promise<Totals> {
    const rows = await this.store.query(q);
    const t: Totals = { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, unpricedCalls: 0 };
    for (const e of rows) {
      t.calls++;
      t.cost += e.cost ?? 0;
      t.unpricedCalls += e.cost === null ? 1 : 0;
      t.inputTokens += e.usage.inputTokens;
      t.outputTokens += e.usage.outputTokens;
      t.cachedInputTokens += e.usage.cachedInputTokens;
    }
    return t;
  }

  /** Spend grouped by user, feature or model, most expensive first. */
  async breakdown(by: "user" | "feature" | "model", q: Query = {}): Promise<Array<{ key: string; cost: number; calls: number; tokens: number }>> {
    const groups = new Map<string, { key: string; cost: number; calls: number; tokens: number }>();
    for (const e of await this.store.query(q)) {
      const key = (e[by] as string | undefined) ?? "(none)";
      const g = groups.get(key) ?? { key, cost: 0, calls: 0, tokens: 0 };
      g.cost += e.cost ?? 0;
      g.calls++;
      g.tokens += e.usage.inputTokens + e.usage.cachedInputTokens + e.usage.outputTokens;
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => b.cost - a.cost);
  }
}

function isUsage(v: unknown): v is Usage {
  return !!v && typeof v === "object" && "inputTokens" in v && "outputTokens" in v;
}
