"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Card, Select, Toggle, Button } from "@/shared/components";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Rotation settings panel.
 *
 * The knobs themselves live in `open-sse/config/rotationSettings.js` (server
 * code). This component keeps its own copy of the presentation metadata so the
 * client bundle never has to pull in the open-sse module graph, and so the
 * settings API stays the single source of truth for the values.
 *
 * Scope: with a `providerId` the panel edits that provider's override
 * (`providerStrategies[providerId].rotation`); without one it edits the global
 * defaults (`settings.rotation`). Effective value = defaults ← global ← provider.
 */
const GROUPS = [
  {
    title: "Account selection",
    fields: [
      {
        key: "maxAttemptsPerRequest",
        label: "Max accounts per request",
        type: "number",
        min: 0,
        max: 1000,
        hint: "0 = unlimited. Caps how many accounts one request burns through — without it a failing request calls every account in the pool.",
      },
      {
        key: "cooldownPerModel",
        label: "Cooldown per model only",
        type: "toggle",
        hint: "On: only the failing model is locked. Off: the whole account is locked — correct for Codex, where every model shares one quota.",
      },
      {
        key: "quotaAwareAccounts",
        label: "Check quota before selecting an account",
        type: "toggle",
        hint: "Codex only. Ask each account whether it still has quota (cached for the interval below) instead of discovering it from an upstream 429. A spent account is skipped until its quota comes back, so requests stop burning a round trip on a dead account.",
      },
      {
        key: "requestShapedNoRotation",
        label: "Don't rotate on a bad request",
        type: "toggle",
        hint: "On: a 400/413/415/422 caused by the caller's payload (bad JSON schema, json_object without the word \"json\") is returned as-is instead of locking the account and trying the next one. Off: restore walking the pool on any error — one bad request then burns up to \"Max accounts per request\" accounts and answers 503.",
      },
      {
        key: "quotaCacheTtlMs",
        label: "Quota re-check interval",
        type: "duration",
        min: MINUTE,
        max: HOUR,
        hint: "How long a quota reading is trusted, and how long a spent account waits between re-checks. Lower picks up an early reset sooner at the cost of more quota calls.",
      },
    ],
  },
  {
    title: "Cooldown when quota runs out",
    fields: [
      {
        key: "maxRateLimitCooldownMs",
        label: "Cap on the provider-reported reset",
        type: "select",
        options: [
          { value: "0", label: "Honour the provider (no cap)" },
          { value: String(30 * MINUTE), label: "30 minutes (legacy)" },
          { value: String(2 * HOUR), label: "2 hours" },
          { value: String(DAY), label: "24 hours" },
          { value: String(7 * DAY), label: "7 days" },
        ],
        hint: "A Codex free account resets roughly monthly. A 30 minute cap retried it every half hour forever — use “no cap” for Codex.",
      },
      {
        key: "transientCooldownMs",
        label: "Transient failure",
        type: "duration",
        min: 0,
        max: DAY,
        hint: "Used for unrecognised upstream errors.",
      },
      {
        key: "longCooldownMs",
        label: "Auth / billing / not-found",
        type: "duration",
        min: 0,
        max: DAY,
        hint: "401, 402, 403, 404 and credential errors.",
      },
      {
        key: "shortCooldownMs",
        label: "“Request not allowed”",
        type: "duration",
        min: 0,
        max: HOUR,
        hint: "Short, recoverable rejections.",
      },
    ],
  },
  {
    title: "Backoff on rate limit",
    fields: [
      { key: "backoffBaseMs", label: "Base delay", type: "duration", min: 100, max: 10 * MINUTE, hint: "First retry delay; doubles each level." },
      { key: "backoffMaxMs", label: "Max delay", type: "duration", min: 1000, max: DAY, hint: "Ceiling for the exponential backoff." },
      { key: "backoffMaxLevel", label: "Max level", type: "number", min: 1, max: 100, hint: "How many doublings before the ceiling applies." },
    ],
  },
  {
    title: "When every account is exhausted",
    fields: [
      {
        key: "onAllExhausted",
        label: "Behaviour",
        type: "select",
        options: [
          { value: "fail", label: "Return an error immediately" },
          { value: "wait-nearest-reset", label: "Wait for the nearest reset" },
        ],
        hint: "Waiting only happens when the reset is within the budget below.",
      },
      {
        key: "maxWaitForResetMs",
        label: "Max wait for a reset",
        type: "duration",
        min: 0,
        max: 10 * MINUTE,
        hint: "0 = never wait. Only used with “wait for the nearest reset”.",
      },
    ],
  },
];

const ALL_FIELDS = GROUPS.flatMap((group) => group.fields);

/** ms → compact label ("1.5h", "30m", "5s"). */
function formatDuration(ms) {
  if (!ms) return "0s";
  if (ms >= DAY && ms % DAY === 0) return `${ms / DAY}d`;
  if (ms >= HOUR) return `${Number((ms / HOUR).toFixed(2))}h`;
  if (ms >= MINUTE) return `${Number((ms / MINUTE).toFixed(2))}m`;
  if (ms >= 1000) return `${Number((ms / 1000).toFixed(1))}s`;
  return `${ms}ms`;
}

/** Form values are strings for inputs; booleans stay booleans. */
function toFormValues(source) {
  const values = {};
  for (const field of ALL_FIELDS) {
    const raw = source?.[field.key];
    if (field.type === "toggle") values[field.key] = raw !== false;
    else if (field.type === "select") values[field.key] = raw == null ? "" : String(raw);
    else values[field.key] = raw == null || raw === "" ? String(field.min ?? 0) : String(raw);
  }
  return values;
}

/** Form values → API payload (numbers coerced, toggles boolean). */
function toPayload(values) {
  const payload = {};
  for (const field of ALL_FIELDS) {
    const raw = values[field.key];
    if (field.type === "toggle") {
      payload[field.key] = !!raw;
      continue;
    }
    const num = Number(raw);
    if (raw === "" || !Number.isFinite(num)) continue;
    payload[field.key] = num;
  }
  return payload;
}

export default function RotationSettingsCard({ providerId = null }) {
  const [values, setValues] = useState(() => toFormValues(null));
  const [hasOverride, setHasOverride] = useState(false);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | saving | saved | error
  const [loading, setLoading] = useState(true);
  const saveTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const global = data.rotation || {};
      const override = providerId ? data.providerStrategies?.[providerId]?.rotation || null : null;
      setHasOverride(!!override);
      setValues(toFormValues({ ...global, ...(override || {}) }));
    } catch (e) {
      console.log("RotationSettingsCard load error:", e);
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  // Same pattern as the rest of this dashboard (pre-existing repo-wide warning):
  // the loader is async, so state only lands after the awaited fetch resolves.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const persist = useCallback(async (nextValues) => {
    setStatus("saving");
    try {
      const rotation = toPayload(nextValues);
      let body;
      if (providerId) {
        // Re-read first: PATCH replaces the whole providerStrategies key, so the
        // existing fallbackStrategy / stickyRoundRobinLimit must be preserved.
        const res = await fetch("/api/settings", { cache: "no-store" });
        const data = res.ok ? await res.json() : {};
        const strategies = { ...(data.providerStrategies || {}) };
        strategies[providerId] = { ...(strategies[providerId] || {}), rotation };
        body = { providerStrategies: strategies };
      } else {
        body = { rotation };
      }
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (providerId) setHasOverride(true);
      setStatus("saved");
      setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
    } catch (e) {
      console.log("RotationSettingsCard save error:", e);
      setStatus("error");
    }
  }, [providerId]);

  const queueSave = useCallback((nextValues, delay = 500) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persist(nextValues), delay);
  }, [persist]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const update = (key, value, immediate = false) => {
    const next = { ...values, [key]: value };
    setValues(next);
    queueSave(next, immediate ? 0 : 500);
  };

  const clearOverride = async () => {
    if (!providerId) {
      setStatus("saving");
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotation: {} }),
      });
      setStatus("saved");
      await load();
      return;
    }
    setStatus("saving");
    const res = await fetch("/api/settings", { cache: "no-store" });
    const data = res.ok ? await res.json() : {};
    const strategies = { ...(data.providerStrategies || {}) };
    if (strategies[providerId]) {
      const { rotation, ...rest } = strategies[providerId];
      if (Object.keys(rest).length === 0) delete strategies[providerId];
      else strategies[providerId] = rest;
    }
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerStrategies: strategies }),
    });
    setStatus("saved");
    await load();
  };

  const statusLabel = { idle: "", saving: "Saving…", saved: "Saved", error: "Save failed" }[status];

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Rotation settings</h3>
          {providerId && hasOverride && <span className="text-[11px] px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-600">override</span>}
          <span className="text-xs text-text-muted">{providerId ? "this provider" : "all providers"}</span>
        </div>
        <span className="flex items-center gap-2 text-xs text-text-muted">
          {statusLabel}
          <span className="material-symbols-outlined text-[18px]">{open ? "expand_less" : "expand_more"}</span>
        </span>
      </button>

      {open && (
        <div className="mt-4 flex flex-col gap-5">
          {loading ? (
            <div className="h-16 animate-pulse bg-black/5 rounded-lg" />
          ) : (
            <>
              {GROUPS.map((group) => (
                <div key={group.title} className="flex flex-col gap-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{group.title}</h4>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {group.fields.map((field) => {
                      if (field.type === "toggle") {
                        return (
                          <div key={field.key} className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-sm text-text-main">{field.label}</div>
                              <div className="text-xs text-text-muted">{field.hint}</div>
                            </div>
                            <Toggle checked={values[field.key] !== false} onChange={(checked) => update(field.key, checked, true)} />
                          </div>
                        );
                      }
                      if (field.type === "select") {
                        const current = values[field.key];
                        // A value written through the API may not be one of the
                        // presets — keep it selectable instead of showing blank.
                        const options = current === "" || field.options.some((o) => o.value === current)
                          ? field.options
                          : [...field.options, { value: current, label: `Custom (${current} ms)` }];
                        return (
                          <Select
                            key={field.key}
                            label={field.label}
                            hint={field.hint}
                            value={current}
                            options={options}
                            onChange={(e) => update(field.key, e.target.value, true)}
                          />
                        );
                      }
                      const numeric = Number(values[field.key]);
                      return (
                        <div key={field.key} className="flex flex-col gap-1.5">
                          <label className="text-sm font-medium text-text-main">
                            {field.label}
                            {field.type === "duration" && Number.isFinite(numeric) && (
                              <span className="ml-2 text-xs font-normal text-text-muted">{formatDuration(numeric)}</span>
                            )}
                          </label>
                          <input
                            type="number"
                            min={field.min}
                            max={field.max}
                            value={values[field.key]}
                            onChange={(e) => update(field.key, e.target.value)}
                            className="w-full py-2 px-3 text-sm text-text-main bg-surface-2 border border-transparent rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40"
                          />
                          <p className="text-xs text-text-muted">{field.hint}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between gap-3 pt-1 border-t border-black/[0.06] dark:border-white/[0.06]">
                <p className="text-xs text-text-muted">
                  {providerId
                    ? "Inherits the global defaults unless changed here."
                    : "Applies to every provider that has no override."}
                </p>
                <Button size="sm" variant="ghost" onClick={clearOverride} disabled={providerId ? !hasOverride : false}>
                  {providerId ? "Use global defaults" : "Reset to defaults"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
