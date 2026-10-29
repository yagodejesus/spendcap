# Changelog

## 0.1.0 — 2026-10-29

- Usage parsing for OpenAI Chat Completions and Responses, Anthropic Messages and Gemini, including prompt-cache tokens.
- Price tables with exact ids, dated-version matching and globs; `Meter` with totals, breakdowns and estimates.
- `Budget` with per-user, per-feature and global hourly/daily/monthly limits, time-zone-aware resets, `check`, `assert` and `guard`; pluggable `Store`.
