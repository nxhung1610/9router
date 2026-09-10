// Locks the CommandCode connect timeout.
//
// Why: base.js wraps fetch() with an AbortController that fires after
// `this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS` (60s default). A connect
// failure is retried using the 502 retry config (3 attempts, 3s delay), so the
// worst-case wall time a caller waits is:
//      (attempts + 1) * timeoutMs + attempts * delayMs
//   =  4 * timeoutMs + 9s
// At the 60s default that is 249s before the client sees an error. The registry
// therefore pins a tighter timeout for this provider.
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { CommandCodeExecutor } from "../../open-sse/executors/commandcode.js";
import { DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";

const RETRY_ATTEMPTS = resolveRetryEntry(DEFAULT_RETRY_CONFIG[502]).attempts;
const RETRY_DELAY_MS = resolveRetryEntry(DEFAULT_RETRY_CONFIG[502]).delayMs;

function worstCaseMs(timeoutMs) {
  return (RETRY_ATTEMPTS + 1) * timeoutMs + RETRY_ATTEMPTS * RETRY_DELAY_MS;
}

describe("commandcode connect timeout", () => {
  it("registry pins a timeoutMs so the transport carries it", () => {
    expect(PROVIDERS.commandcode.timeoutMs).toBe(15000);
  });

  it("executor reads it from this.config (the transport object)", () => {
    const ex = new CommandCodeExecutor();
    expect(ex.config.timeoutMs).toBe(15000);
  });

  it("keeps generous headroom over the measured time-to-headers", () => {
    // Measured against api.commandcode.ai /alpha/generate: headers came back in
    // 403-1242ms for a ~9k-token prompt and 463-715ms for a 160k-token prompt.
    const MEASURED_MAX_HEADERS_MS = 1242;
    expect(PROVIDERS.commandcode.timeoutMs).toBeGreaterThan(MEASURED_MAX_HEADERS_MS * 5);
  });

  it("cuts worst-case wait to under 70s (vs 249s at the 60s default)", () => {
    expect(worstCaseMs(PROVIDERS.commandcode.timeoutMs)).toBeLessThan(70000);
    expect(worstCaseMs(FETCH_CONNECT_TIMEOUT_MS)).toBeGreaterThan(200000);
  });
});
