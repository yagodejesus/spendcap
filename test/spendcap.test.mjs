import assert from "node:assert/strict";
import { test } from "node:test";

import { Budget, BudgetExceededError, findPrice, Meter, parseUsage, periodBounds } from "../dist/index.js";

// Example prices (USD per 1M tokens) used only in tests.
const PRICES = {
  "model-small": { input: 0.15, output: 0.6, cachedInput: 0.075 },
  "model-large": { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  "flash-*": { input: 0.1, output: 0.4 },
};

const openaiChat = (model, p, c, cached = 0) => ({ model, usage: { prompt_tokens: p, completion_tokens: c, prompt_tokens_details: { cached_tokens: cached } } });

function clock(start = Date.UTC(2026, 9, 29, 12)) {
  const c = { t: start, now: () => c.t };
  return c;
}

test("usage from every provider format", () => {
  assert.deepEqual(parseUsage(openaiChat("m", 1000, 50, 400)), { model: "m", inputTokens: 600, cachedInputTokens: 400, cacheWriteTokens: 0, outputTokens: 50 });
  assert.deepEqual(parseUsage({ object: "response", model: "m", usage: { input_tokens: 900, output_tokens: 20, input_tokens_details: { cached_tokens: 100 } } }),
    { model: "m", inputTokens: 800, cachedInputTokens: 100, cacheWriteTokens: 0, outputTokens: 20 });
  assert.deepEqual(parseUsage({ type: "message", model: "c", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 } }),
    { model: "c", inputTokens: 10, outputTokens: 5, cachedInputTokens: 2000, cacheWriteTokens: 300 });
  assert.deepEqual(parseUsage({ modelVersion: "g", usageMetadata: { promptTokenCount: 120, cachedContentTokenCount: 20, candidatesTokenCount: 30, thoughtsTokenCount: 10 } }),
    { model: "g", inputTokens: 100, cachedInputTokens: 20, cacheWriteTokens: 0, outputTokens: 40 });
  assert.equal(parseUsage({ text: "no usage" }), undefined);
});

test("price lookup: exact, dated versions and globs", () => {
  assert.equal(findPrice(PRICES, "model-small"), PRICES["model-small"]);
  assert.equal(findPrice(PRICES, "model-small-2026-01-15"), PRICES["model-small"]);
  assert.equal(findPrice(PRICES, "flash-2.5"), PRICES["flash-*"]);
  assert.equal(findPrice(PRICES, "other"), undefined);
});

test("costs include cached reads and cache writes", async () => {
  const meter = new Meter({ prices: PRICES });
  const a = await meter.record(openaiChat("model-small", 1_000_000, 1_000_000, 0));
  assert.equal(a.cost, 0.75);
  const b = await meter.record({ type: "message", model: "model-large", usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 } });
  assert.equal(b.cost, 3 + 0.3 + 3.75);
  assert.equal(meter.estimate("model-large", 1000, 1000), 0.018);
});

test("unknown models: warn once, or throw in strict mode", async () => {
  const seen = [];
  const meter = new Meter({ prices: PRICES, onUnknownModel: (m) => seen.push(m) });
  await meter.record(openaiChat("mystery", 10, 10));
  const e = await meter.record(openaiChat("mystery", 10, 10));
  assert.equal(e.cost, null);
  assert.deepEqual(seen, ["mystery"]);
  assert.equal((await meter.totals()).unpricedCalls, 2);
  await assert.rejects(new Meter({ prices: PRICES, strict: true }).record(openaiChat("mystery", 1, 1)), /no price/);
  await assert.rejects(meter.record({ nothing: true }), /no token usage/);
});

test("totals and breakdowns", async () => {
  const meter = new Meter({ prices: PRICES });
  await meter.record(openaiChat("model-large", 100_000, 10_000), { user: "ana", feature: "chat" });
  await meter.record(openaiChat("model-small", 100_000, 10_000), { user: "bia", feature: "chat" });
  await meter.record(openaiChat("model-small", 50_000, 5_000), { user: "ana", feature: "summarize" });
  const byUser = await meter.breakdown("user");
  assert.deepEqual(byUser.map((g) => g.key), ["ana", "bia"]);
  assert.equal((await meter.totals({ feature: "chat" })).calls, 2);
  assert.ok(Math.abs((await meter.totals({ user: "ana" })).cost - (0.45 + 0.0105)) < 1e-9);
});

test("per-user daily limit blocks and resets at midnight in the configured time zone", async () => {
  const c = clock(Date.UTC(2026, 9, 29, 20)); // 17:00 in Brasília (UTC-3)
  const meter = new Meter({ prices: PRICES, now: c.now });
  const budget = new Budget(meter, { perUser: { daily: 0.5 }, utcOffsetMinutes: -180 });
  await meter.record(openaiChat("model-large", 100_000, 10_000), { user: "ana" }); // $0.45
  assert.equal((await budget.check({ user: "ana" })).allowed, true);
  const d = await budget.check({ user: "ana" }, 0.1);
  assert.equal(d.allowed, false);
  assert.match(d.reason, /user ana daily budget of \$0.50/);
  assert.equal(d.retryAt, Date.UTC(2026, 9, 30, 3)); // midnight in Brasília
  assert.equal((await budget.check({ user: "bia" }, 0.1)).allowed, true);
  c.t = Date.UTC(2026, 9, 30, 3, 1);
  assert.equal((await budget.check({ user: "ana" }, 0.1)).allowed, true);
});

test("global and feature limits, assert and guard", async () => {
  const c = clock();
  const meter = new Meter({ prices: PRICES, now: c.now });
  const budget = new Budget(meter, { global: { monthly: 1 }, perFeature: { "deep-research": { hourly: 0.05 } } });
  const call = async () => openaiChat("model-large", 10_000, 1_000); // $0.045
  await budget.guard({ user: "u", feature: "deep-research" }, call);
  await assert.rejects(budget.guard({ user: "u", feature: "deep-research" }, call, 0.045), BudgetExceededError);
  const ok = await budget.check({ feature: "chat" });
  assert.equal(ok.allowed, true);
  assert.ok(Math.abs(ok.remaining - (1 - 0.045)) < 1e-9);
  c.t += 3_600_000;
  await budget.assert({ feature: "deep-research" }, 0.045);
});

test("period bounds", () => {
  const now = Date.UTC(2026, 1, 15, 10, 30);
  assert.deepEqual(periodBounds("hour", now), [Date.UTC(2026, 1, 15, 10), Date.UTC(2026, 1, 15, 11)]);
  assert.deepEqual(periodBounds("month", now), [Date.UTC(2026, 1, 1), Date.UTC(2026, 2, 1)]);
  assert.deepEqual(periodBounds("day", Date.UTC(2026, 1, 15, 1), -180), [Date.UTC(2026, 1, 14, 3), Date.UTC(2026, 1, 15, 3)]);
});
