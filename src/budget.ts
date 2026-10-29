import type { Context, Meter } from "./meter.js";

export type Period = "hour" | "day" | "month";
export type Limits = Partial<Record<"hourly" | "daily" | "monthly", number>>;

export interface BudgetOptions {
  /** Limits applied to each user separately. */
  perUser?: Limits;
  /** Limits per feature name. */
  perFeature?: Record<string, Limits>;
  /** Limits for all traffic together. */
  global?: Limits;
  /** Where days and months start, in minutes east of UTC (e.g. -180 for Brasília). Default 0. */
  utcOffsetMinutes?: number;
}

export interface LimitStatus {
  name: string;
  spent: number;
  limit: number;
  remaining: number;
  resetsAt: number;
}

export interface Decision {
  allowed: boolean;
  reason?: string;
  /** Smallest remaining amount across the limits that apply (Infinity if none). */
  remaining: number;
  retryAt?: number;
  limits: LimitStatus[];
}

export class BudgetExceededError extends Error {
  constructor(readonly decision: Decision) {
    super(decision.reason ?? "budget exceeded");
    this.name = "BudgetExceededError";
  }
}

const PERIOD: Record<keyof Limits, Period> = { hourly: "hour", daily: "day", monthly: "month" };

export function periodBounds(period: Period, now: number, offsetMinutes = 0): [number, number] {
  const off = offsetMinutes * 60_000;
  const local = new Date(now + off);
  let start: number;
  let end: number;
  if (period === "hour") {
    start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), local.getUTCHours());
    end = start + 3_600_000;
  } else if (period === "day") {
    start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    end = start + 86_400_000;
  } else {
    start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
    end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1);
  }
  return [start - off, end - off];
}

/** Spending limits per user, per feature and overall, checked before each LLM call. */
export class Budget {
  constructor(private readonly meter: Meter, private readonly opts: BudgetOptions) {}

  async check(ctx: Context = {}, estimatedCost = 0): Promise<Decision> {
    const now = this.meter.now();
    const scopes: Array<{ label: string; limits?: Limits; q: { user?: string; feature?: string } }> = [
      { label: "global", limits: this.opts.global, q: {} },
    ];
    if (ctx.user !== undefined) scopes.push({ label: `user ${ctx.user}`, limits: this.opts.perUser, q: { user: ctx.user } });
    if (ctx.feature !== undefined) scopes.push({ label: `feature ${ctx.feature}`, limits: this.opts.perFeature?.[ctx.feature], q: { feature: ctx.feature } });
    const limits: LimitStatus[] = [];
    let failed: LimitStatus | undefined;
    for (const s of scopes) {
      for (const [key, usd] of Object.entries(s.limits ?? {}) as Array<[keyof Limits, number]>) {
        if (usd === undefined) continue;
        const [since, until] = periodBounds(PERIOD[key], now, this.opts.utcOffsetMinutes);
        const spent = (await this.meter.totals({ ...s.q, since, until })).cost;
        const st: LimitStatus = { name: `${s.label} ${key}`, spent, limit: usd, remaining: Math.max(0, usd - spent), resetsAt: until };
        limits.push(st);
        if (spent + estimatedCost > usd && (!failed || st.resetsAt > failed.resetsAt)) failed = st;
      }
    }
    const remaining = limits.length ? Math.min(...limits.map((l) => l.remaining)) : Infinity;
    if (failed) {
      return {
        allowed: false,
        reason: `${failed.name} budget of $${failed.limit.toFixed(2)} reached ($${failed.spent.toFixed(4)} spent)`,
        remaining,
        retryAt: failed.resetsAt,
        limits,
      };
    }
    return { allowed: true, remaining, limits };
  }

  async assert(ctx: Context = {}, estimatedCost = 0): Promise<void> {
    const d = await this.check(ctx, estimatedCost);
    if (!d.allowed) throw new BudgetExceededError(d);
  }

  /** Check the budget, run the call, record its usage, return its result. */
  async guard<T>(ctx: Context, fn: () => Promise<T>, estimatedCost = 0): Promise<T> {
    await this.assert(ctx, estimatedCost);
    const result = await fn();
    await this.meter.record(result, ctx);
    return result;
  }
}
