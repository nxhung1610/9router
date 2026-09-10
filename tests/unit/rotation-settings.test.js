/**
 * Rotation settings — pure resolution + cooldown capping.
 *
 * The regression these guard: a provider-reported reset (Codex free accounts
 * report a ~monthly reset) used to be truncated by a flat 30 minute cap, so an
 * exhausted account was retried every half hour forever.
 */
import { describe, it, expect } from "vitest";

import {
  ROTATION_DEFAULTS,
  ON_ALL_EXHAUSTED,
  sanitizeRotationSettings,
  resolveRotationSettings,
  applyCooldownCap,
} from "open-sse/config/rotationSettings.js";
import { checkFallbackError, getQuotaCooldown } from "open-sse/services/accountFallback.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe("resolveRotationSettings", () => {
  it("returns the full defaults when no settings exist", () => {
    expect(resolveRotationSettings(null, null)).toEqual({ ...ROTATION_DEFAULTS });
    expect(resolveRotationSettings(undefined, "codex")).toEqual({ ...ROTATION_DEFAULTS });
  });

  it("applies global overrides", () => {
    const rotation = resolveRotationSettings({ rotation: { maxAttemptsPerRequest: 2 } }, null);
    expect(rotation.maxAttemptsPerRequest).toBe(2);
    expect(rotation.transientCooldownMs).toBe(ROTATION_DEFAULTS.transientCooldownMs);
  });

  it("lets a per-provider override win over the global value", () => {
    const settings = {
      rotation: { maxAttemptsPerRequest: 2 },
      providerStrategies: { codex: { rotation: { maxAttemptsPerRequest: 9 } } },
    };
    expect(resolveRotationSettings(settings, "codex").maxAttemptsPerRequest).toBe(9);
    expect(resolveRotationSettings(settings, "claude").maxAttemptsPerRequest).toBe(2);
    expect(resolveRotationSettings(settings, null).maxAttemptsPerRequest).toBe(2);
  });

  it("uncapped by default so a monthly reset is honoured", () => {
    const rotation = resolveRotationSettings({}, "codex");
    const now = Date.now();
    const monthlyReset = now + 30 * 24 * HOUR;

    // The old code did Math.min(resetsAtMs - now, 30 * MIN) — assert we no longer do.
    expect(applyCooldownCap(monthlyReset, rotation.maxRateLimitCooldownMs, now)).toBe(monthlyReset - now);
  });

  it("caps when a cap is configured", () => {
    const rotation = resolveRotationSettings({ rotation: { maxRateLimitCooldownMs: 30 * MIN } }, "codex");
    const now = Date.now();
    const monthlyReset = now + 30 * 24 * HOUR;
    expect(applyCooldownCap(monthlyReset, rotation.maxRateLimitCooldownMs, now)).toBe(30 * MIN);
  });
});

describe("applyCooldownCap", () => {
  it("never returns a negative cooldown for an already-passed reset", () => {
    expect(applyCooldownCap(Date.now() - HOUR, 0)).toBe(0);
    expect(applyCooldownCap(Date.now() - HOUR, 30 * MIN)).toBe(0);
  });

  it("treats 0 / undefined / negative caps as uncapped", () => {
    const now = Date.now();
    const reset = now + 6 * HOUR;
    expect(applyCooldownCap(reset, 0, now)).toBe(6 * HOUR);
    expect(applyCooldownCap(reset, undefined, now)).toBe(6 * HOUR);
    expect(applyCooldownCap(reset, -1, now)).toBe(6 * HOUR);
  });
});

describe("sanitizeRotationSettings", () => {
  it("drops unknown keys", () => {
    expect(sanitizeRotationSettings({ nope: 1, maxAttemptsPerRequest: 3 })).toEqual({ maxAttemptsPerRequest: 3 });
  });

  it("clamps numbers into bounds and coerces numeric strings", () => {
    expect(sanitizeRotationSettings({ maxAttemptsPerRequest: -5 }).maxAttemptsPerRequest).toBe(0);
    expect(sanitizeRotationSettings({ backoffBaseMs: "1500" }).backoffBaseMs).toBe(1500);
    expect(sanitizeRotationSettings({ backoffMaxLevel: 9999 }).backoffMaxLevel).toBe(100);
  });

  it("drops values that are not finite numbers", () => {
    expect(sanitizeRotationSettings({ transientCooldownMs: "abc" })).toEqual({});
    expect(sanitizeRotationSettings({ transientCooldownMs: NaN })).toEqual({});
    expect(sanitizeRotationSettings({ transientCooldownMs: Infinity })).toEqual({});
  });

  it("coerces cooldownPerModel to a boolean", () => {
    expect(sanitizeRotationSettings({ cooldownPerModel: false })).toEqual({ cooldownPerModel: false });
    expect(sanitizeRotationSettings({ cooldownPerModel: 0 })).toEqual({ cooldownPerModel: false });
    expect(sanitizeRotationSettings({ cooldownPerModel: "yes" })).toEqual({ cooldownPerModel: true });
  });

  it("only accepts known onAllExhausted modes", () => {
    expect(sanitizeRotationSettings({ onAllExhausted: "fail" }).onAllExhausted).toBe(ON_ALL_EXHAUSTED.FAIL);
    expect(sanitizeRotationSettings({ onAllExhausted: "wait-nearest-reset" }).onAllExhausted)
      .toBe(ON_ALL_EXHAUSTED.WAIT_NEAREST_RESET);
    expect(sanitizeRotationSettings({ onAllExhausted: "explode" })).toEqual({});
  });

  it("ignores non-object input", () => {
    expect(sanitizeRotationSettings(null)).toEqual({});
    expect(sanitizeRotationSettings("x")).toEqual({});
    expect(sanitizeRotationSettings([1, 2])).toEqual({});
  });
});

describe("checkFallbackError without rotation keeps legacy behaviour", () => {
  it("uses the historical constants", () => {
    expect(checkFallbackError(404, "not found").cooldownMs).toBe(2 * MIN);
    expect(checkFallbackError(500, "boom").cooldownMs).toBe(30 * 1000);
    expect(checkFallbackError(429, "rate limit", 0).cooldownMs).toBe(2 * 1000); // level 1 → base * 2^0
  });

  it("backs off exponentially from the configured base", () => {
    // max(0, level-1) with level 1 → 2^0, level 2 → 2^1 …
    expect(getQuotaCooldown(1)).toBe(2 * 1000);
    expect(getQuotaCooldown(2)).toBe(4 * 1000);
    expect(getQuotaCooldown(3)).toBe(8 * 1000);
  });
});

describe("checkFallbackError honours rotation overrides", () => {
  const rotation = resolveRotationSettings({
    rotation: {
      longCooldownMs: 10 * MIN,
      shortCooldownMs: 1000,
      transientCooldownMs: 7 * MIN,
      backoffBaseMs: 500,
      backoffMaxMs: 2000,
      backoffMaxLevel: 3,
    },
  }, null);

  it("uses the override for status-matched rules", () => {
    expect(checkFallbackError(404, "not found", 0, rotation).cooldownMs).toBe(10 * MIN);
    expect(checkFallbackError(401, "unauthorized", 0, rotation).cooldownMs).toBe(10 * MIN);
  });

  it("uses the override for text-matched rules", () => {
    expect(checkFallbackError(400, "request not allowed here", 0, rotation).cooldownMs).toBe(1000);
  });

  it("uses the override for the transient fallback", () => {
    expect(checkFallbackError(500, "unexpected kaboom", 0, rotation).cooldownMs).toBe(7 * MIN);
  });

  it("uses the override for exponential backoff and its ceiling/level", () => {
    expect(checkFallbackError(429, "rate limit exceeded", 0, rotation).cooldownMs).toBe(500);
    expect(checkFallbackError(429, "rate limit exceeded", 1, rotation).cooldownMs).toBe(1000);
    expect(checkFallbackError(429, "rate limit exceeded", 2, rotation).cooldownMs).toBe(2000);
    // capped by backoffMaxMs
    expect(checkFallbackError(429, "rate limit exceeded", 5, rotation).cooldownMs).toBe(2000);
    // newBackoffLevel clamps at backoffMaxLevel
    expect(checkFallbackError(429, "rate limit exceeded", 3, rotation).newBackoffLevel).toBe(3);
  });
});
