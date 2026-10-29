/** Token usage, normalized across providers. Input tokens never include cached tokens. */
export interface Usage {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

type Obj = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Reads usage from OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and Google Gemini responses
 * (SDK objects or plain JSON). Returns undefined when there is no usage information.
 */
export function parseUsage(response: unknown): Usage | undefined {
  if (!response || typeof response !== "object") return undefined;
  const r = response as Obj;
  const model = typeof r.model === "string" ? r.model : typeof r.modelVersion === "string" ? r.modelVersion : undefined;
  const meta = r.usageMetadata as Obj | undefined;
  if (meta) {
    const prompt = num(meta.promptTokenCount);
    const cached = num(meta.cachedContentTokenCount);
    return { model, inputTokens: prompt - cached, cachedInputTokens: cached, cacheWriteTokens: 0,
      outputTokens: num(meta.candidatesTokenCount) + num(meta.thoughtsTokenCount) };
  }
  const u = r.usage as Obj | undefined;
  if (!u) return undefined;
  if ("prompt_tokens" in u) {
    const cached = num((u.prompt_tokens_details as Obj | undefined)?.cached_tokens);
    return { model, inputTokens: num(u.prompt_tokens) - cached, cachedInputTokens: cached, cacheWriteTokens: 0, outputTokens: num(u.completion_tokens) };
  }
  if ("cache_read_input_tokens" in u || "cache_creation_input_tokens" in u || r.type === "message") {
    return { model, inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens),
      cachedInputTokens: num(u.cache_read_input_tokens), cacheWriteTokens: num(u.cache_creation_input_tokens) };
  }
  if ("input_tokens" in u || "output_tokens" in u) {
    const cached = num((u.input_tokens_details as Obj | undefined)?.cached_tokens);
    return { model, inputTokens: num(u.input_tokens) - cached, cachedInputTokens: cached, cacheWriteTokens: 0, outputTokens: num(u.output_tokens) };
  }
  return undefined;
}
