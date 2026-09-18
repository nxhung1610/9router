import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const CONN = { id: "cx-1", provider: "codex", name: "cx-1", backoffLevel: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnections.mockResolvedValue([CONN]);
  dbMocks.getSettings.mockResolvedValue({});
});

describe("Enh4: markAccountUnavailable KHONG xoay account khi loi do payload", () => {
  it("HTTP 400 'must contain the word json' -> shouldFallback FALSE, khong lock account", async () => {
    const res = await markAccountUnavailable(
      "cx-1",
      400,
      `{"error":{"message":"Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.","type":"invalid_request_error"}}`,
      "codex",
      "gpt-5.6-luna",
    );

    expect(res.shouldFallback).toBe(false);
    expect(res.cooldownMs).toBe(0);
    expect(res.requestShaped).toBe(true);
    // KHONG duoc ghi lock / testStatus len DB
    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("HTTP 400 'Invalid schema for response_format' -> khong xoay", async () => {
    const res = await markAccountUnavailable(
      "cx-1",
      400,
      `{"error":{"message":"Invalid schema for response_format 'c': In context=(), 'required' is required to be supplied and to be an array including every key in properties."}}`,
      "codex",
      "gpt-5.6-luna",
    );
    expect(res.shouldFallback).toBe(false);
    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("422 / 413 / 415 cung khong xoay", async () => {
    for (const status of [422, 413, 415]) {
      vi.clearAllMocks();
      dbMocks.getProviderConnections.mockResolvedValue([CONN]);
      dbMocks.getSettings.mockResolvedValue({});
      const res = await markAccountUnavailable("cx-1", status, "unprocessable", "codex", "m");
      expect(res.shouldFallback, `status ${status}`).toBe(false);
    }
  });
});

describe("Enh4: cac loi CUA ACCOUNT van xoay nhu cu (khong pha regression)", () => {
  it("429 van fallback (doi account la dung)", async () => {
    const res = await markAccountUnavailable("cx-1", 429, "rate limit exceeded", "codex", "m");
    expect(res.shouldFallback).toBe(true);
    expect(dbMocks.updateProviderConnection).toHaveBeenCalled();
  });

  it("401 / 402 / 403 van fallback (auth / billing cua account)", async () => {
    for (const status of [401, 402, 403]) {
      vi.clearAllMocks();
      dbMocks.getProviderConnections.mockResolvedValue([CONN]);
      dbMocks.getSettings.mockResolvedValue({});
      const res = await markAccountUnavailable("cx-1", status, "account problem", "codex", "m");
      expect(res.shouldFallback, `status ${status}`).toBe(true);
    }
  });

  it("404 van fallback (model availability khac nhau theo account)", async () => {
    const res = await markAccountUnavailable("cx-1", 404, "model not found", "codex", "m");
    expect(res.shouldFallback).toBe(true);
  });

  it("503 / 502 van fallback (loi ha tang upstream)", async () => {
    for (const status of [503, 502]) {
      vi.clearAllMocks();
      dbMocks.getProviderConnections.mockResolvedValue([CONN]);
      dbMocks.getSettings.mockResolvedValue({});
      const res = await markAccountUnavailable("cx-1", status, "upstream down", "codex", "m");
      expect(res.shouldFallback, `status ${status}`).toBe(true);
    }
  });

  it("provider bao reset (resetsAtMs) THANG phan loai request-shaped: 400 + resetsAtMs van fallback", async () => {
    const future = Date.now() + 60 * 60 * 1000;
    // resetsAtMs la bang chung cap ACCOUNT (provider noi ro quota cua account nay
    // se hoi) -> phai thang suy doan tu status code. Neu khong, mot account het
    // quota bao kem 400 se bi coi la loi payload va khong bao gio duoc xoay.
    const res = await markAccountUnavailable("cx-1", 400, "quota", "codex", "m", future);
    expect(res.shouldFallback).toBe(true);
    expect(dbMocks.updateProviderConnection).toHaveBeenCalled();
  });

  it("resetsAtMs da HET HAN thi khong cuu duoc: 400 van la request-shaped", async () => {
    const past = Date.now() - 1000;
    const res = await markAccountUnavailable("cx-1", 400, "bad payload", "codex", "m", past);
    expect(res.shouldFallback).toBe(false);
  });

  it("GitHub monthly exhaustion THANG phan loai: 402 + message that van fallback", async () => {
    // githubMonthlyResetMs doi status 402 + substring nay; status 402 KHONG nam
    // trong REQUEST_SHAPED_STATUSES nen truong hop nay von da xoay — test nay
    // ghim rang viec them phan loai khong vo tinh chan duong GitHub.
    const res = await markAccountUnavailable(
      "cx-1",
      402,
      "you've reached your additional usage limit for your plan",
      "github",
      "m",
    );
    expect(res.shouldFallback).toBe(true);
  });
});

describe("Enh4: toggle tat duoc -> khoi phuc hanh vi cu", () => {
  it("requestShapedNoRotation=false -> 400 LAI xoay account nhu truoc", async () => {
    dbMocks.getSettings.mockResolvedValue({ rotation: { requestShapedNoRotation: false } });
    const res = await markAccountUnavailable(
      "cx-1",
      400,
      `{"error":{"message":"Response input messages must contain the word 'json'..."}}`,
      "codex",
      "gpt-5.6-luna",
    );
    expect(res.shouldFallback).toBe(true);
    expect(dbMocks.updateProviderConnection).toHaveBeenCalled();
  });
});
