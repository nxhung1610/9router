/**
 * Account-isolated egress for Codex.
 *
 * Codex requests carry an account's OAuth token, so they must leave through the
 * proxy assigned to that connection. These tests exercise the real
 * proxyAwareFetch (no module mock) to prove that a Codex account action with no
 * assigned proxy is refused instead of quietly using the host's own egress.
 */

import { describe, expect, it, vi } from "vitest";
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { getCodexUsage, getCodexRateLimitResetCredits, consumeCodexRateLimitResetCredit } from "../../open-sse/services/usage/codex.js";

const ISOLATION_ERROR = /Account-isolated proxy required/;

describe("Codex account egress isolation", () => {
  it("refuses image generation for a Codex account with no assigned proxy", async () => {
    const fetchSpy = vi.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchSpy;
    try {
      const result = await handleImageGenerationCore({
        body: { prompt: "A blue square" },
        modelInfo: { provider: "codex", model: "gpt-5.5-image" },
        credentials: { accessToken: "codex-token", providerSpecificData: {} },
        log: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(ISOLATION_ERROR);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("refuses a Codex usage read with no assigned proxy", async () => {
    await expect(getCodexUsage("codex-token", { strictProxy: true })).rejects.toThrow(ISOLATION_ERROR);
  });

  it("refuses reading and consuming reset credits with no assigned proxy", async () => {
    await expect(getCodexRateLimitResetCredits("codex-token")).rejects.toThrow(ISOLATION_ERROR);
    await expect(consumeCodexRateLimitResetCredit("codex-token", "redeem-1")).rejects.toThrow(ISOLATION_ERROR);
  });
});
