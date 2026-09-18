import { describe, it, expect } from "vitest";
import { REQUEST_SHAPED_STATUSES } from "open-sse/config/errorConfig.js";
import {
  resolveRotationSettings,
  sanitizeRotationSettings,
  ROTATION_DEFAULTS,
} from "open-sse/config/rotationSettings.js";

// Enhancement 4: a request-shaped 4xx (the CALLER's payload is wrong) must not
// lock the account and walk the pool. Measured in production: a json_object
// request without the word "json" returns 400 on every account, yet the relay
// burned 5 accounts (rotation.maxAttemptsPerRequest) and answered
// "503 rotation attempt cap reached (5 accounts tried, cap 5)".
//
// The classification lives in errorConfig + auth.js (markAccountUnavailable),
// deliberately NOT in checkFallbackError — that one is shared with combo model
// fallback, where trying another MODEL on a 400 is legitimate.

describe("Enh4: request-shaped status classification", () => {
  it("400 / 413 / 415 / 422 are request-shaped", () => {
    for (const s of [400, 413, 415, 422]) {
      expect(REQUEST_SHAPED_STATUSES.has(s), `${s} phai la request-shaped`).toBe(true);
    }
  });

  it("khong phan loai nham loi CUA ACCOUNT la request-shaped", () => {
    // 401/402/403 = auth/billing cua account -> doi account la dung
    // 404 = model availability khac nhau theo account
    // 408/429 = dang thu lai
    // 5xx = loi ha tang upstream
    for (const s of [200, 201, 401, 402, 403, 404, 405, 406, 408, 409, 429, 500, 502, 503, 504]) {
      expect(REQUEST_SHAPED_STATUSES.has(s), `${s} KHONG duoc la request-shaped`).toBe(false);
    }
  });
});

describe("Enh4: toggle requestShapedNoRotation", () => {
  it("mac dinh BAT (tra 4xx thang, khong xoay account)", () => {
    expect(ROTATION_DEFAULTS.requestShapedNoRotation).toBe(true);
    expect(resolveRotationSettings(null, "codex").requestShapedNoRotation).toBe(true);
  });

  it("tat duoc qua settings (khoi phuc hanh vi cu)", () => {
    const out = sanitizeRotationSettings({ requestShapedNoRotation: false });
    expect(out.requestShapedNoRotation).toBe(false);
    const resolved = resolveRotationSettings({ rotation: { requestShapedNoRotation: false } }, "codex");
    expect(resolved.requestShapedNoRotation).toBe(false);
  });

  it('chuoi "false"/"off" tu form HTML khong bi coi la truthy', () => {
    expect(sanitizeRotationSettings({ requestShapedNoRotation: "false" }).requestShapedNoRotation).toBe(false);
    expect(sanitizeRotationSettings({ requestShapedNoRotation: "off" }).requestShapedNoRotation).toBe(false);
    expect(sanitizeRotationSettings({ requestShapedNoRotation: "0" }).requestShapedNoRotation).toBe(false);
    expect(sanitizeRotationSettings({ requestShapedNoRotation: "true" }).requestShapedNoRotation).toBe(true);
    expect(sanitizeRotationSettings({ requestShapedNoRotation: "on" }).requestShapedNoRotation).toBe(true);
  });

  it("override theo provider hoat dong (providerStrategies[id].rotation)", () => {
    const settings = {
      rotation: { requestShapedNoRotation: true },
      providerStrategies: { codex: { rotation: { requestShapedNoRotation: false } } },
    };
    expect(resolveRotationSettings(settings, "codex").requestShapedNoRotation).toBe(false);
    expect(resolveRotationSettings(settings, "openai-compatible-chat-x").requestShapedNoRotation).toBe(true);
    // khong truyen provider -> dung global
    expect(resolveRotationSettings(settings, null).requestShapedNoRotation).toBe(true);
  });

  it("gia tri rac bi bo qua (khong ghi de default)", () => {
    const out = sanitizeRotationSettings({ requestShapedNoRotation: "khong-phai-bool" });
    // toBoolean fallback=true cho chuoi khong nhan dang duoc
    expect(out.requestShapedNoRotation).toBe(true);
    expect(sanitizeRotationSettings({ requestShapedNoRotation: null }).requestShapedNoRotation).toBe(true);
  });
});
