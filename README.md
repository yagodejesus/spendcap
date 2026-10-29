<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="spendcap" width="380">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/yagodejesus/spendcap/actions/workflows/ci.yml"><img src="https://github.com/yagodejesus/spendcap/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/spendcap"><img src="https://img.shields.io/npm/v/spendcap.svg" alt="npm"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT"></a>
</p>

**Know what every LLM call costs — and cap it.** Reads token usage from OpenAI, Anthropic and Gemini responses, prices it (including prompt-cache reads and writes), and enforces budgets per user, per feature and overall before the next call goes out.

> 🇧🇷 *Calcula quanto custa cada chamada a um LLM e impõe limites de gasto por usuário, por funcionalidade e no total, com virada de dia e de mês no fuso horário que você escolher.*

One user with a script, one prompt in a loop, one feature nobody expected to be popular — and the monthly bill arrives with a surprise. Provider dashboards tell you *after*. `spendcap` tells you *per call*, and says no before the damage is done.

```ts
import { Meter, Budget, BudgetExceededError } from "spendcap";

const meter = new Meter({
  prices: {                                   // USD per 1M tokens — copy from your provider's pricing page
    "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
    "claude-*-haiku*": { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 },
  },
});

const budget = new Budget(meter, {
  perUser: { daily: 0.5, monthly: 5 },
  perFeature: { "deep-research": { hourly: 2 } },
  global: { monthly: 800 },
  utcOffsetMinutes: -180,                     // days reset at midnight in Brasília
});

app.post("/chat", async (req, res) => {
  try {
    const reply = await budget.guard({ user: req.user.id, feature: "chat" }, () =>
      openai.chat.completions.create({ model: "gpt-4o-mini", messages: req.body.messages }),
    );
    res.json(reply);
  } catch (e) {
    if (e instanceof BudgetExceededError) return res.status(429).json({ error: e.message, retryAt: e.decision.retryAt });
    throw e;
  }
});
```

`guard()` checks every applicable limit, runs the call, reads its usage and records the cost. You can also use the pieces separately.

## Metering

```ts
const entry = await meter.record(response, { user: "ana", feature: "summarize" });
entry.cost;                                         // 0.000412 (USD), or null for unpriced models

await meter.totals({ user: "ana", since: startOfMonth });
await meter.breakdown("feature");                   // [{ key: "chat", cost, calls, tokens }, …] most expensive first
meter.estimate("gpt-4o-mini", 12_000, 800);         // pre-flight estimate
```

**Usage formats**: OpenAI Chat Completions (`prompt_tokens`, cached tokens), OpenAI Responses (`input_tokens`), Anthropic Messages (`cache_read_input_tokens`, `cache_creation_input_tokens`) and Gemini (`usageMetadata`, thinking tokens counted as output). Cached input is never billed twice.

**Prices** are yours to set — they change too often to hard-code. Keys can be exact ids, base ids that also match dated versions (`gpt-4o-mini` matches `gpt-4o-mini-2024-07-18`) or globs (`"claude-*-haiku*"`). Unknown models are recorded with `cost: null` and reported once through `onUnknownModel` — or rejected with `strict: true`.

## Budgets

```ts
const d = await budget.check({ user: "ana", feature: "chat" }, estimatedCost);
d.allowed;      // false
d.reason;       // "user ana daily budget of $0.50 reached ($0.5012 spent)"
d.retryAt;      // when that limit resets (ms timestamp)
d.remaining;    // the tightest remaining amount across all limits
d.limits;       // every limit that applied, with spent/limit/remaining/resetsAt
```

Hourly, daily and monthly limits use calendar periods in the time zone you configure, so "daily" means *your* day.

## Storage

The default `MemoryStore` keeps 40 days of entries in memory — enough for a single server. For several instances, implement the two-method `Store` interface (`add`, `query`) over Redis, Postgres or anything else; both may be async.

## Install

```bash
npm install spendcap
```

ESM, Node ≥ 20, Bun and Deno. No dependencies.

## Development

```bash
git clone https://github.com/yagodejesus/spendcap && cd spendcap
npm install
npm test
```

## License

MIT © Yago de Jesus Martins
