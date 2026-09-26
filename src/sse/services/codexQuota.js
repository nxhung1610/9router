/**
 * Codex quota-aware account gate — in-memory cache, refreshed on demand.
 *
 * Why this exists: a Codex *free* account carries a single account-wide quota
 * window that resets roughly monthly, and every model on the account shares it.
 * The generic rotation logic only learns an account is dead *after* upstream
 * answers 429, so a request walks into an exhausted account, burns a round trip
 * and only then moves on — and with `fill-first` it does that on every single
 * request once the priority-0 account is dry.
 *
 * This module answers "does this account still have quota?" *before* the account
 * is selected, and caches the answer:
 *
 *   - first check for an account costs one usage call (all accounts are checked
 *     in parallel: 11 accounts ≈ 1s measured)
 *   - a fresh reading is trusted for `quotaCacheTtlMs` (default 5 min)
 *   - an exhausted reading blocks the account until the reported reset, but is
 *     re-checked every TTL anyway so a quota that comes back early is picked up
 *   - any failure (usage API down, token expired, malformed body) is treated as
 *     "unknown" and the account is allowed: the gate must never be able to take
 *     the whole provider offline on its own.
 *
 * It is a *pre-filter*, not a replacement for the `modelLock_*` bookkeeping in
 * auth.js: an upstream 429 still locks the account exactly as before. The two
 * layers answer different questions — "known dry" vs "just failed".
 *
 * Scope: Codex only. Other providers bill per model or per token, where an
 * account-level gate would be wrong.
 */

import { getCodexUsage } from "open-sse/services/usage/codex.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import * as log from "../utils/logger.js";

/**
 * connectionId → reading
 * {
 *   known: boolean,        // did upstream actually report a usable window?
 *   exhausted: boolean,    // known && (limitReached || remaining <= 0)
 *   remaining: number|null,
 *   limitReached: boolean,
 *   resetAt: string|null,
 *   checkedAt: number,
 *   nextCheckAt: number
 * }
 */
const quotaCache = new Map();
// In-flight refresh promises — dedup concurrent requests hitting the same account.
const inflight = new Map();

/**
 * Reduce a `getCodexUsage()` result to a cache reading. Pure, so the TTL /
 * reset-at interplay can be tested without network or timers.
 *
 * @param {object|null} usage - result of getCodexUsage()
 * @param {number} ttlMs - how long a reading stays fresh
 * @param {number} now
 */
export function evaluateCodexQuota(usage, ttlMs, now = Date.now()) {
  const quota = usage?.quotas?.session || null;
  const remaining = typeof quota?.remaining === "number" ? quota.remaining : null;
  const limitReached = usage?.limitReached === true;

  // `message` is how the usage handler reports a failed call; a body without a
  // session window tells us nothing about the quota, so treat it as unknown.
  const known = !usage?.message && (quota !== null || limitReached);

  const exhausted = known && (limitReached || (remaining !== null && remaining <= 0));
  const resetAt = quota?.resetAt || null;

  return {
    known,
    exhausted,
    remaining,
    limitReached,
    resetAt,
    checkedAt: now,
    nextCheckAt: computeNextCheckAt({ exhausted, resetAt }, ttlMs, now),
  };
}

/**
 * When the reading may be trusted without asking upstream again.
 *
 * A healthy account is simply re-checked after the TTL. An exhausted one is
 * blocked until its reset — but never longer than one TTL between checks, so an
 * early reset (or newly granted credits) is noticed within a few minutes
 * instead of waiting out a window that is a month away.
 */
function computeNextCheckAt({ exhausted, resetAt }, ttlMs, now) {
  const ttlDeadline = now + ttlMs;
  if (!exhausted) return ttlDeadline;

  const resetMs = resetAt ? new Date(resetAt).getTime() : NaN;
  if (!Number.isFinite(resetMs) || resetMs <= now) return ttlDeadline;
  return Math.min(resetMs, ttlDeadline);
}

/**
 * Read-only reference to the cache (auth.js pre-filter, tests).
 */
export function getCodexQuotaCache() {
  return quotaCache;
}

/**
 * Should this account be skipped right now?
 *
 * Fail-open by design: an account with no reading, or whose reading has expired,
 * is allowed through — `ensureCodexQuota` refreshes it first, and if that fails
 * the account is simply treated as usable (same behaviour as before this gate).
 *
 * @param {string} connectionId
 * @param {number} now
 */
export function isCodexAccountBlocked(connectionId, now = Date.now()) {
  const reading = quotaCache.get(connectionId);
  if (!reading || !reading.known) return false;
  if (now >= reading.nextCheckAt) return false; // stale — a refresh is due
  return reading.exhausted === true;
}

/**
 * Earliest reset among the connections currently blocked by quota, as epoch ms.
 *
 * The auth pre-filter uses this to answer "when can we try again?" when every
 * account was filtered out for quota reasons — those accounts have no
 * `modelLock_*` field, so the lock-based expiry lookup alone would report
 * "no credentials at all" instead of a retry time.
 *
 * @param {Array} connections
 * @param {number} now
 * @returns {number|null}
 */
export function getEarliestCodexQuotaReset(connections, now = Date.now()) {
  let earliest = null;
  for (const conn of connections || []) {
    const reading = conn?.id ? quotaCache.get(conn.id) : null;
    if (!reading?.known || !reading.exhausted) continue;
    if (now >= reading.nextCheckAt) continue; // expired reading no longer blocks
    const resetMs = reading.resetAt ? new Date(reading.resetAt).getTime() : NaN;
    const deadline = Number.isFinite(resetMs) && resetMs > now ? Math.min(resetMs, reading.nextCheckAt) : reading.nextCheckAt;
    if (!earliest || deadline < earliest) earliest = deadline;
  }
  return earliest;
}

/**
 * Record an exhausted account straight from an upstream error, skipping the
 * usage call: a 429 with a provider-reported reset already told us everything.
 *
 * @param {string} connectionId
 * @param {number|null} resetAtMs - absolute epoch ms the provider reported
 * @param {number} ttlMs
 * @param {number} now
 */
export function recordCodexQuotaExhaustion(connectionId, resetAtMs, ttlMs, now = Date.now()) {
  if (!connectionId) return;
  const resetAt = Number.isFinite(resetAtMs) && resetAtMs > now
    ? new Date(resetAtMs).toISOString()
    : null;
  quotaCache.set(connectionId, {
    known: true,
    exhausted: true,
    remaining: 0,
    limitReached: true,
    resetAt,
    checkedAt: now,
    nextCheckAt: computeNextCheckAt({ exhausted: true, resetAt }, ttlMs, now),
  });
}

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg?.connectionProxyEnabled === true,
    connectionProxyUrl: cfg?.connectionProxyUrl || "",
    connectionNoProxy: cfg?.connectionNoProxy || "",
    vercelRelayUrl: cfg?.vercelRelayUrl || "",
    // Account quota probes must use the assigned account proxy or fail closed.
    strictProxy: true,
    requireAccountProxy: true,
  };
}

async function refreshOne(conn, ttlMs, now) {
  try {
    const cfg = await resolveConnectionProxyConfig(conn.providerSpecificData || {});
    const usage = await getCodexUsage(conn.accessToken, buildProxyOptions(cfg));
    const reading = evaluateCodexQuota(usage, ttlMs, Date.now());
    quotaCache.set(conn.id, reading);

    const account = String(conn.id).slice(0, 8);
    if (reading.exhausted) {
      log.info("CODEX_QUOTA", `${account} | EXHAUSTED session ${reading.remaining ?? "?"}% — skip until ${reading.resetAt || "next check"}`);
    } else if (reading.known) {
      log.debug("CODEX_QUOTA", `${account} | ok session remaining ${reading.remaining}%`);
    } else {
      log.debug("CODEX_QUOTA", `${account} | unknown reading — account stays available`);
    }
    return reading;
  } catch (e) {
    // Fail-open: never let a quota probe decide an account is unusable.
    log.debug("CODEX_QUOTA", `${String(conn.id).slice(0, 8)} | probe failed: ${e.message}`);
    quotaCache.set(conn.id, {
      known: false,
      exhausted: false,
      remaining: null,
      limitReached: false,
      resetAt: null,
      checkedAt: now,
      nextCheckAt: now + ttlMs,
    });
    return null;
  } finally {
    inflight.delete(conn.id);
  }
}

/**
 * Bring the cache up to date for every candidate connection, in parallel.
 *
 * Only accounts whose reading has expired are probed, so a warm cache costs
 * nothing on the request path. Resolves when all probes settle — callers then
 * read the cache synchronously.
 *
 * @param {Array} connections - candidate connections (need id + accessToken)
 * @param {object} options - { ttlMs, enabled }
 */
export async function ensureCodexQuota(connections, { ttlMs, enabled = true } = {}) {
  if (!enabled || !Array.isArray(connections) || connections.length === 0) return;

  const now = Date.now();
  const stale = connections.filter((c) => {
    if (!c?.id || !c.accessToken) return false;
    const reading = quotaCache.get(c.id);
    return !reading || now >= reading.nextCheckAt;
  });
  if (stale.length === 0) return;

  await Promise.allSettled(
    stale.map((conn) => {
      const existing = inflight.get(conn.id);
      if (existing) return existing;
      const promise = refreshOne(conn, ttlMs, now);
      inflight.set(conn.id, promise);
      return promise;
    })
  );
}
