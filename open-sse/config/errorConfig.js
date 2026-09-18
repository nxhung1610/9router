// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (legacy default).
// Prefer `rotation.maxRateLimitCooldownMs` (see config/rotationSettings.js),
// where 0 means "honour the provider-reported reset as-is". Codex free accounts
// reset roughly monthly, so a flat 30 minute cap made an exhausted account look
// available again every half hour.
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms) — defaults for the long/short rule buckets below.
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, cooldownKey?, backoff?, noFallback? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration (default)
 *   - cooldownKey: name of the rotation setting that overrides `cooldownMs`
 *   - backoff: true = use exponential backoff (rate limit)
 *   - noFallback: true = the failure belongs to the CALLER's payload, so another
 *     account would fail identically. Return the upstream response instead of
 *     locking this account and walking the pool (see checkFallbackError).
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { text: "no credentials",           cooldownMs: COOLDOWN.long,  cooldownKey: "longCooldownMs" },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short, cooldownKey: "shortCooldownMs" },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long, cooldownKey: "longCooldownMs" },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long,  cooldownKey: "longCooldownMs" },
  { status: 402, cooldownMs: COOLDOWN.long,  cooldownKey: "longCooldownMs" },
  { status: 403, cooldownMs: COOLDOWN.long,  cooldownKey: "longCooldownMs" },
  { status: 404, cooldownMs: COOLDOWN.long,  cooldownKey: "longCooldownMs" },
  { status: 429, backoff: true },
];

/**
 * Statuses that describe the REQUEST, not the account. A malformed payload
 * (bad JSON schema, `json_object` without the word "json" in the prompt, an
 * unsupported param, an oversized body) fails identically on every account, so
 * retrying it across the pool burns quota to produce the same 4xx N times — and
 * the relay then answers `503 rotation attempt cap reached`, hiding the caller's
 * real error.
 *
 * Deliberately EXCLUDED: 401/402/403 (account auth/billing), 404 (model
 * availability genuinely differs per account — e.g. a free Codex account without
 * access to a model), 408/429 (worth another account), and all 5xx.
 *
 * Measured in production: 16 such rows in one 1000-row window, all HTTP 400 —
 * `Invalid schema for response_format '<name>'` and `Response input messages
 * must contain the word 'json'` — each costing a rotation walk.
 */
export const REQUEST_SHAPED_STATUSES = new Set([400, 413, 415, 422]);


// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
