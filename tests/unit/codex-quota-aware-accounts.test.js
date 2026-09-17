/**
 * Codex quota-aware account gate.
 *
 * The behaviour under test: an account whose quota is spent must not be called
 * again until a fresh quota check says it is usable. Before this gate, an
 * exhausted Codex account was only discovered *after* upstream answered 429, so
 * every request paid a wasted round trip to a dead account (measured: 265 of 288
 * Codex requests in 72h landed on one account until it ran dry).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  getCodexUsage: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("open-sse/services/usage/codex.js", () => ({
  getCodexUsage: mocks.getCodexUsage,
}));
vi.mock("open-sse/services/usage/google.js", () => ({
  getAntigravityUsage: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const {
  evaluateCodexQuota,
  ensureCodexQuota,
  isCodexAccountBlocked,
  recordCodexQuotaExhaustion,
  getEarliestCodexQuotaReset,
  getCodexQuotaCache,
} = await import("@/sse/services/codexQuota.js");
const { getProviderCredentials, markAccountUnavailable } = await import("@/sse/services/auth.js");

const TTL = 5 * 60 * 1000;
const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const RESET_MONTHLY = "2026-10-17T15:51:16.000Z";

const usage = ({ remaining = 100, limitReached = false, resetAt = RESET_MONTHLY } = {}) => ({
  plan: "free",
  limitReached,
  quotas: { session: { used: 100 - remaining, total: 100, remaining, resetAt, unlimited: false } },
});

function connection(id, priority) {
  return { id, email: `${id}@example.com`, isActive: true, priority, accessToken: `token-${id}`, providerSpecificData: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  getCodexQuotaCache().clear();
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.getSettings.mockResolvedValue({});
  mocks.getCodexUsage.mockResolvedValue(usage());
});

describe("evaluateCodexQuota", () => {
  it("reads remaining quota as healthy and re-checks only after the TTL", () => {
    expect(evaluateCodexQuota(usage({ remaining: 94 }), TTL, NOW)).toEqual({
      known: true,
      exhausted: false,
      remaining: 94,
      limitReached: false,
      resetAt: RESET_MONTHLY,
      checkedAt: NOW,
      nextCheckAt: NOW + TTL,
    });
  });

  it("treats remaining 0 as exhausted", () => {
    const reading = evaluateCodexQuota(usage({ remaining: 0 }), TTL, NOW);
    expect(reading.exhausted).toBe(true);
  });

  it("treats the limitReached flag as exhausted even when remaining lags", () => {
    const reading = evaluateCodexQuota(usage({ remaining: 12, limitReached: true }), TTL, NOW);
    expect(reading.exhausted).toBe(true);
  });

  it("bounds the re-check of an exhausted account by the TTL, not the month-long reset", () => {
    // The reset is a month out; waiting for it would hide a quota that comes
    // back early, so the TTL caps the wait.
    const reading = evaluateCodexQuota(usage({ remaining: 0 }), TTL, NOW);
    expect(reading.nextCheckAt).toBe(NOW + TTL);
    expect(reading.nextCheckAt).toBeLessThan(Date.parse(RESET_MONTHLY));
  });

  it("re-checks at the reset when that lands before the TTL expires", () => {
    const soon = new Date(NOW + 60_000).toISOString();
    const reading = evaluateCodexQuota(usage({ remaining: 0, resetAt: soon }), TTL, NOW);
    expect(reading.nextCheckAt).toBe(NOW + 60_000);
  });

  it("marks a body without a usable window as unknown, not exhausted", () => {
    // The usage handler reports failures as { message } instead of throwing.
    expect(evaluateCodexQuota({ message: "Usage API temporarily unavailable (503)." }, TTL, NOW).known).toBe(false);
    expect(evaluateCodexQuota(null, TTL, NOW).known).toBe(false);
    expect(evaluateCodexQuota({ quotas: {} }, TTL, NOW).known).toBe(false);
  });
});

describe("isCodexAccountBlocked", () => {
  it("allows an account with no reading (fail-open before the first check)", () => {
    expect(isCodexAccountBlocked("unknown", NOW)).toBe(false);
  });

  it("blocks an exhausted account and releases it once the reading expires", () => {
    recordCodexQuotaExhaustion("acct-a", null, TTL, NOW);
    expect(isCodexAccountBlocked("acct-a", NOW + 1000)).toBe(true);
    expect(isCodexAccountBlocked("acct-a", NOW + TTL + 1)).toBe(false);
  });

  it("never blocks on an unknown reading", () => {
    ensureCodexQuota([connection("acct-a")], { ttlMs: TTL }); // no await: cache still empty
    expect(isCodexAccountBlocked("acct-a", NOW)).toBe(false);
  });
});

describe("recordCodexQuotaExhaustion", () => {
  it("keeps the provider-reported reset when it is in the future", () => {
    recordCodexQuotaExhaustion("acct-a", Date.parse(RESET_MONTHLY), TTL, NOW);
    expect(getCodexQuotaCache().get("acct-a").resetAt).toBe(RESET_MONTHLY);
  });

  it("ignores a reset that already passed and still blocks for the TTL", () => {
    recordCodexQuotaExhaustion("acct-a", NOW - 60_000, TTL, NOW);
    const reading = getCodexQuotaCache().get("acct-a");
    expect(reading.resetAt).toBeNull();
    expect(reading.nextCheckAt).toBe(NOW + TTL);
  });
});

describe("getEarliestCodexQuotaReset", () => {
  it("returns the soonest blocking deadline across connections", () => {
    recordCodexQuotaExhaustion("a", NOW + 120_000, TTL, NOW);
    recordCodexQuotaExhaustion("b", NOW + 30_000, TTL, NOW);
    expect(getEarliestCodexQuotaReset([connection("a"), connection("b")], NOW)).toBe(NOW + 30_000);
  });

  it("ignores healthy connections and expired readings", () => {
    expect(getEarliestCodexQuotaReset([connection("healthy")], NOW)).toBeNull();
    recordCodexQuotaExhaustion("a", null, TTL, NOW);
    expect(getEarliestCodexQuotaReset([connection("a")], NOW + TTL + 1)).toBeNull();
  });
});

describe("ensureCodexQuota", () => {
  it("probes every stale account in parallel and fills the cache", async () => {
    await ensureCodexQuota([connection("a"), connection("b")], { ttlMs: TTL });
    expect(mocks.getCodexUsage).toHaveBeenCalledTimes(2);
    expect(getCodexQuotaCache().get("a").known).toBe(true);
    expect(getCodexQuotaCache().get("b").known).toBe(true);
  });

  it("does not probe a fresh reading again", async () => {
    await ensureCodexQuota([connection("a")], { ttlMs: TTL });
    mocks.getCodexUsage.mockClear();
    await ensureCodexQuota([connection("a")], { ttlMs: TTL });
    expect(mocks.getCodexUsage).not.toHaveBeenCalled();
  });

  it("re-probes once the TTL expires, so a returned quota is noticed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      mocks.getCodexUsage.mockResolvedValue(usage({ remaining: 0 }));
      await ensureCodexQuota([connection("a")], { ttlMs: TTL });
      expect(isCodexAccountBlocked("a")).toBe(true);

      vi.setSystemTime(NOW + TTL + 1);
      mocks.getCodexUsage.mockResolvedValue(usage({ remaining: 100 }));
      await ensureCodexQuota([connection("a")], { ttlMs: TTL });

      expect(isCodexAccountBlocked("a")).toBe(false);
      expect(getCodexQuotaCache().get("a").remaining).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open when the quota probe throws", async () => {
    mocks.getCodexUsage.mockRejectedValue(new Error("network down"));
    await ensureCodexQuota([connection("a")], { ttlMs: TTL });
    expect(isCodexAccountBlocked("a", Date.now())).toBe(false);
    expect(getCodexQuotaCache().get("a").known).toBe(false);
  });

  it("skips connections without a token instead of crashing", async () => {
    await ensureCodexQuota([{ id: "no-token", providerSpecificData: {} }], { ttlMs: TTL });
    expect(mocks.getCodexUsage).not.toHaveBeenCalled();
  });

  it("is a no-op when disabled", async () => {
    await ensureCodexQuota([connection("a")], { ttlMs: TTL, enabled: false });
    expect(mocks.getCodexUsage).not.toHaveBeenCalled();
  });
});

describe("auth.js integration — Codex account selection is quota-aware", () => {
  it("skips a spent account and picks the next one", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("spent", 1), connection("fresh", 2)]);
    mocks.getCodexUsage.mockImplementation(async (token) =>
      token === "token-spent" ? usage({ remaining: 0, limitReached: true }) : usage({ remaining: 100 }));

    const credentials = await getProviderCredentials("codex", null, "gpt-5.6-luna");
    expect(credentials.connectionId).toBe("fresh");
  });

  it("fails open when the quota endpoint is unavailable", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("only", 1)]);
    mocks.getCodexUsage.mockResolvedValue({ message: "Usage API temporarily unavailable (503)." });

    const credentials = await getProviderCredentials("codex", null, "gpt-5.6-luna");
    expect(credentials.connectionId).toBe("only");
  });

  it("reports a retry time when every account is out of quota", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("a", 1), connection("b", 2)]);
    mocks.getCodexUsage.mockResolvedValue(usage({ remaining: 0, limitReached: true }));

    const result = await getProviderCredentials("codex", null, "gpt-5.6-luna");
    expect(result.allRateLimited).toBe(true);
    expect(result.retryAfter).toBeTruthy();
  });

  it("does not gate non-Codex providers", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "cc-1", email: "cc@example.com", isActive: true, priority: 1, apiKey: "k", providerSpecificData: {} },
    ]);
    const credentials = await getProviderCredentials("commandcode", null, "some-model");
    expect(credentials.connectionId).toBe("cc-1");
    expect(mocks.getCodexUsage).not.toHaveBeenCalled();
  });

  it("does not hold the selection mutex across the quota probe", async () => {
    // The mutex serialises account selection for EVERY provider, so a ~2s quota
    // probe held inside it would stall unrelated requests. The probe must run
    // before the lock is taken: while one Codex selection is mid-probe, another
    // provider's selection must still complete without waiting for it.
    const PROBE_MS = 400;
    mocks.getProviderConnections.mockImplementation(async (filter) => {
      if (filter?.provider === "codex") return [connection("cx-1", 1), connection("cx-2", 2)];
      return [{ id: "cc-1", apiKey: "k", isActive: true, priority: 1, providerSpecificData: {} }];
    });
    mocks.getCodexUsage.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, PROBE_MS));
      return usage({ remaining: 100 });
    });

    const codexCall = getProviderCredentials("codex", null, "gpt-5.6-luna");
    await new Promise((r) => setTimeout(r, 30)); // let the Codex call enter its probe

    const t0 = Date.now();
    const other = await getProviderCredentials("commandcode", null, "some-model");
    const waited = Date.now() - t0;
    await codexCall;

    expect(other.connectionId).toBe("cc-1");
    // The unrelated selection must not have queued behind a 400ms probe.
    expect(waited).toBeLessThan(PROBE_MS / 2);
  });

  it("honours rotation.quotaAwareAccounts=false", async () => {
    mocks.getSettings.mockResolvedValue({ rotation: { quotaAwareAccounts: false } });
    mocks.getProviderConnections.mockResolvedValue([connection("only", 1)]);

    const credentials = await getProviderCredentials("codex", null, "gpt-5.6-luna");
    expect(credentials.connectionId).toBe("only");
    expect(mocks.getCodexUsage).not.toHaveBeenCalled();
  });

  it("learns from an upstream 429 so the next request skips that account", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("spent", 1), connection("fresh", 2)]);
    mocks.getCodexUsage.mockResolvedValue(usage({ remaining: 100 }));

    // A 429 with the provider's own reset lands outside the gate (handler path).
    await markAccountUnavailable("spent", 429, "The usage limit has been reached", "codex", "gpt-5.6-luna", Date.parse(RESET_MONTHLY));

    expect(getCodexQuotaCache().get("spent").exhausted).toBe(true);
    const credentials = await getProviderCredentials("codex", null, "gpt-5.6-luna");
    expect(credentials.connectionId).toBe("fresh");
  });

  it("does not treat a 404 as quota exhaustion", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("acct", 1)]);
    mocks.getCodexUsage.mockResolvedValue(usage({ remaining: 100 }));

    await markAccountUnavailable("acct", 404, "model not found", "codex", "gpt-5.6-luna", null);
    expect(getCodexQuotaCache().get("acct")).toBeUndefined();
  });
});
