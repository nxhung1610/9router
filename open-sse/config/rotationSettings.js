/**
 * Rotation settings — the tunable knobs for account rotation / fallback.
 *
 * Background: account rotation is driven by three places that used to hard-code
 * their numbers:
 *   - `open-sse/services/accountFallback.js` (backoff + error cooldowns)
 *   - `src/sse/services/auth.js` (provider-reported resets_at cooldown)
 *   - `src/sse/handlers/chat.js` (how many accounts one request may try)
 *
 * Those constants are still the defaults, but every one of them can now be
 * overridden globally (`settings.rotation`) or per provider
 * (`settings.providerStrategies[providerId].rotation`).
 *
 * Why it matters: a Codex *free* account resets its quota about once a month,
 * but a flat `MAX_RATE_LIMIT_COOLDOWN_MS` of 30 minutes truncated that reset —
 * so an exhausted account was retried every half hour forever. Respecting the
 * provider-reported reset (`maxRateLimitCooldownMs: 0`) is what makes a pool of
 * accounts actually usable.
 */

import {
  BACKOFF_CONFIG,
  TRANSIENT_COOLDOWN_MS,
} from "./errorConfig.js";

const MINUTE = 60 * 1000;

/** How a request behaves once every account of a provider is exhausted. */
export const ON_ALL_EXHAUSTED = Object.freeze({
  FAIL: "fail",
  WAIT_NEAREST_RESET: "wait-nearest-reset",
});

/**
 * Defaults. Kept intentionally aligned with the historical constants so an
 * install that never touches these settings behaves the same as before, with
 * one deliberate exception: `maxRateLimitCooldownMs` defaults to 0 (= honour
 * the provider-reported reset) instead of the old flat 30 minute cap.
 */
export const ROTATION_DEFAULTS = Object.freeze({
  /** Max accounts one request may try before giving up. 0 = unlimited. */
  maxAttemptsPerRequest: 5,
  /** Cap for a provider-reported reset. 0 = honour it as-is (no cap). */
  maxRateLimitCooldownMs: 0,
  /** Cooldown for unrecognised / transient failures. */
  transientCooldownMs: TRANSIENT_COOLDOWN_MS,
  /** Cooldown for auth / billing / not-found style failures. */
  longCooldownMs: 2 * MINUTE,
  /** Cooldown for "request not allowed" style failures. */
  shortCooldownMs: 5 * 1000,
  /** Exponential backoff base for rate-limit failures. */
  backoffBaseMs: BACKOFF_CONFIG.base,
  /** Exponential backoff ceiling. */
  backoffMaxMs: BACKOFF_CONFIG.max,
  /** Exponential backoff max level. */
  backoffMaxLevel: BACKOFF_CONFIG.maxLevel,
  /** Lock only the failing model (true) or the whole account (false). */
  cooldownPerModel: true,
  /**
   * Behaviour when every account is exhausted.
   */
  onAllExhausted: ON_ALL_EXHAUSTED.FAIL,
  /**
   * How long a request may block waiting for the nearest account reset when
   * `onAllExhausted` is "wait-nearest-reset". 0 = never wait (fail fast).
   * Bounded on purpose: a reset can be a month away, and holding the request
   * that long is worse than an immediate 503.
   */
  maxWaitForResetMs: 0,
  /**
   * (Codex) Check each account's quota *before* selecting it, instead of only
   * learning it is dry from an upstream 429. See src/sse/services/codexQuota.js.
   */
  quotaAwareAccounts: true,
  /**
   * (Codex) How long a quota reading is trusted before it is re-checked. Also
   * bounds how long an exhausted account waits between re-checks, so an early
   * reset is picked up in minutes rather than at the end of a month-long window.
   */
  quotaCacheTtlMs: 5 * MINUTE,
});

/** Inclusive bounds used to reject nonsense from the settings API / UI. */
export const ROTATION_BOUNDS = Object.freeze({
  maxAttemptsPerRequest: { min: 0, max: 1000 },
  maxRateLimitCooldownMs: { min: 0, max: 30 * 24 * 60 * MINUTE },
  transientCooldownMs: { min: 0, max: 24 * 60 * MINUTE },
  longCooldownMs: { min: 0, max: 24 * 60 * MINUTE },
  shortCooldownMs: { min: 0, max: 60 * MINUTE },
  backoffBaseMs: { min: 100, max: 10 * MINUTE },
  backoffMaxMs: { min: 1000, max: 24 * 60 * MINUTE },
  backoffMaxLevel: { min: 1, max: 100 },
  maxWaitForResetMs: { min: 0, max: 10 * MINUTE },
  /**
   * Floor of one minute: the gate exists to avoid hammering the quota endpoint,
   * and a TTL below that would probe upstream on nearly every request. Ceiling
   * of one hour keeps a reset from going unnoticed for too long.
   */
  quotaCacheTtlMs: { min: MINUTE, max: 60 * MINUTE },
});

const NUMERIC_KEYS = Object.keys(ROTATION_BOUNDS);

function clampNumber(value, { min, max }) {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

const FALSY_STRINGS = ["false", "0", "no", "off", ""];
const TRUTHY_STRINGS = ["true", "1", "yes", "on"];

/**
 * Coerce a form value to a boolean. HTML forms submit strings, so "false" / "0"
 * / "off" must not be treated as truthy just because they are non-empty.
 */
function toBoolean(value, fallback = true) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : fallback;
  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (FALSY_STRINGS.includes(normalised)) return false;
    if (TRUTHY_STRINGS.includes(normalised)) return true;
  }
  return fallback;
}

/**
 * Drop unknown keys and clamp numbers. Returns a partial object containing only
 * the keys the caller actually supplied and that survived validation, so it can
 * be spread over defaults without resurrecting invalid values.
 */
export function sanitizeRotationSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};

  const out = {};
  for (const key of NUMERIC_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const clamped = clampNumber(input[key], ROTATION_BOUNDS[key]);
    if (clamped !== null) out[key] = clamped;
  }

  if (Object.prototype.hasOwnProperty.call(input, "cooldownPerModel")) {
    out.cooldownPerModel = toBoolean(input.cooldownPerModel, true);
  }

  if (Object.prototype.hasOwnProperty.call(input, "quotaAwareAccounts")) {
    out.quotaAwareAccounts = toBoolean(input.quotaAwareAccounts, true);
  }

  if (Object.prototype.hasOwnProperty.call(input, "onAllExhausted")) {
    const mode = String(input.onAllExhausted);
    if (Object.values(ON_ALL_EXHAUSTED).includes(mode)) out.onAllExhausted = mode;
  }

  return out;
}

/**
 * Resolve the effective rotation settings for a provider.
 *
 * Precedence (lowest → highest):
 *   ROTATION_DEFAULTS → settings.rotation → settings.providerStrategies[provider].rotation
 *
 * Pure and total: always returns a fully populated, validated object, so callers
 * never have to null-check individual fields.
 *
 * @param {object|null} settings - result of getSettings()
 * @param {string|null} providerId
 */
export function resolveRotationSettings(settings, providerId = null) {
  const global = sanitizeRotationSettings(settings?.rotation);
  const providerOverride = providerId
    ? sanitizeRotationSettings(settings?.providerStrategies?.[providerId]?.rotation)
    : {};

  return { ...ROTATION_DEFAULTS, ...global, ...providerOverride };
}

/**
 * Apply the configured cap to a provider-reported reset.
 *
 * @param {number} resetsAtMs - absolute epoch ms reported by the provider
 * @param {number} maxCooldownMs - configured cap; 0 or below disables capping
 * @param {number} nowMs
 * @returns {number} cooldown in ms (never negative)
 */
export function applyCooldownCap(resetsAtMs, maxCooldownMs, nowMs = Date.now()) {
  const remaining = Math.max(0, resetsAtMs - nowMs);
  if (!maxCooldownMs || maxCooldownMs <= 0) return remaining;
  return Math.min(remaining, maxCooldownMs);
}

/**
 * How long a request should block waiting for the nearest account reset.
 *
 * Returns 0 when waiting is disabled, when the provider gave no usable
 * `retryAfter`, or when the reset falls outside the budget — a reset can be a
 * month away, and holding the request that long is worse than failing fast.
 *
 * @param {object|null} credentials - the allRateLimited result of getProviderCredentials
 * @param {object} rotation - resolved rotation settings
 * @param {number} nowMs
 * @returns {number} ms to wait, or 0 to not wait
 */
export function resolveResetWaitMs(credentials, rotation, nowMs = Date.now()) {
  if (!rotation || rotation.onAllExhausted !== ON_ALL_EXHAUSTED.WAIT_NEAREST_RESET) return 0;

  const budget = rotation.maxWaitForResetMs;
  if (!Number.isFinite(budget) || budget <= 0) return 0;

  const resetAtMs = credentials?.retryAfter ? new Date(credentials.retryAfter).getTime() : NaN;
  if (!Number.isFinite(resetAtMs)) return 0;

  const waitMs = resetAtMs - nowMs;
  if (waitMs <= 0 || waitMs > budget) return 0;

  return waitMs;
}
