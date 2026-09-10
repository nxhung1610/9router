// Locks the CommandCode usage extractor to the upstream wire shape.
//
// Upstream (api.commandcode.ai/alpha/generate) reports:
//   inputTokens: 16788            <- cache-INCLUSIVE (cold run reported the same 16788)
//   inputTokenDetails: { noCacheTokens: 148, cacheReadTokens: 16640 }   (148+16640 = 16788)
//   outputTokens: 16              <- inclusive of reasoning
//   outputTokenDetails: { textTokens: 0, reasoningTokens: 16 }
//   cachedInputTokens: 16640      <- top-level mirror of inputTokenDetails.cacheReadTokens
//
// The bug this guards: the extractor dropped the cache fields entirely, so
// usageHistory.cached_tokens stayed 0 and calculateCostFromTokens billed the
// whole prompt at the full input rate (measured ~43x overstatement on
// deepseek/deepseek-v4.1-flash, whose cached rate is 0.003 vs 0.15 input).
import { describe, it, expect } from "vitest";
import { toOpenAIUsage } from "../../open-sse/translator/concerns/usage.js";
import { calculateCostFromTokens, getPricingForModel } from "../../open-sse/providers/pricing.js";

// Verbatim capture from a warm-cache request.
const WARM = {
  inputTokens: 16788,
  inputTokenDetails: { noCacheTokens: 148, cacheReadTokens: 16640 },
  outputTokens: 16,
  outputTokenDetails: { textTokens: 0, reasoningTokens: 16 },
  totalTokens: 16804,
  reasoningTokens: 16,
  cachedInputTokens: 16640,
};

describe("commandcode usage: cache fields are surfaced", () => {
  it("maps cachedInputTokens into prompt_tokens_details.cached_tokens", () => {
    const u = toOpenAIUsage(WARM, "commandcode");
    expect(u.prompt_tokens).toBe(16788);
    expect(u.completion_tokens).toBe(16);
    expect(u.total_tokens).toBe(16804);
    expect(u.prompt_tokens_details.cached_tokens).toBe(16640);
  });

  it("prompt_tokens stays cache-INCLUSIVE (cache is not folded on top)", () => {
    const u = toOpenAIUsage(WARM, "commandcode");
    // Folding would give 148 + 16640 + 16640 = 33428; upstream says 16788.
    expect(u.prompt_tokens).toBe(16788);
    expect(u.prompt_tokens).not.toBe(33428);
  });

  it("reads inputTokenDetails.cacheReadTokens when the flat mirror is absent", () => {
    const { cachedInputTokens, ...noMirror } = WARM;
    const u = toOpenAIUsage(noMirror, "commandcode");
    expect(u.prompt_tokens_details.cached_tokens).toBe(16640);
  });

  it("tolerates the flat cacheReadTokens shape", () => {
    const u = toOpenAIUsage({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 60 }, "commandcode");
    expect(u.prompt_tokens_details.cached_tokens).toBe(60);
  });

  it("does not emit reasoningTokens (outputTokens already includes reasoning)", () => {
    const u = toOpenAIUsage(WARM, "commandcode");
    // completion_tokens_details.reasoning_tokens would be charged ON TOP of
    // completion_tokens by calculateCostFromTokens -> double billing.
    expect(u.completion_tokens_details).toBeUndefined();
  });

  it("no cache -> no prompt_tokens_details", () => {
    const u = toOpenAIUsage({ inputTokens: 8, outputTokens: 2, totalTokens: 99 }, "commandcode");
    expect(u.prompt_tokens).toBe(8);
    expect(u.total_tokens).toBe(99);
    expect(u.prompt_tokens_details).toBeUndefined();
  });

  it("falls back to input+output when totalTokens is missing", () => {
    const u = toOpenAIUsage({ inputTokens: 10, outputTokens: 4 }, "commandcode");
    expect(u.total_tokens).toBe(14);
  });
});

describe("commandcode usage: cost impact", () => {
  it("bills the cached portion at the cached rate, not the input rate", () => {
    const u = toOpenAIUsage(WARM, "commandcode");
    const pricing = getPricingForModel("commandcode", "deepseek/deepseek-v4.1-flash");
    expect(pricing).toBeTruthy();

    const withCache = calculateCostFromTokens(
      { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens,
        cached_tokens: u.prompt_tokens_details.cached_tokens },
      pricing,
    );
    const asIfNoCache = calculateCostFromTokens(
      { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens },
      pricing,
    );

    // 16640 tokens must be billed at 0.003 instead of 0.15 per 1M.
    expect(withCache).toBeLessThan(asIfNoCache);
    expect(asIfNoCache / withCache).toBeGreaterThan(10);
  });
});
