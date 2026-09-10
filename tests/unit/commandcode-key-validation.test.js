/**
 * Command Code connection test + key validation semantics.
 *
 * Measured upstream behaviour (2026-09-10, live):
 *   POST https://api.commandcode.ai/alpha/generate   + stream:false
 *     → 400 "Proxy use detected. This endpoint only serves CLI." for a VALID key
 *       AND for an INVALID key. Status-based checks there can never detect a bad key.
 *   POST https://api.commandcode.ai/provider/v1/chat/completions + stream:true
 *     → 401 for an invalid key, 200 for a valid key.
 * With stream:false on the provider endpoint the invalid key ALSO returns 400, so the
 * stream:true flag is load-bearing, not cosmetic.
 *
 * These tests pin the request the code must send, because regressing to the transport
 * URL (or to stream:false) silently turns "bad key" into "connected".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TEST_URL = "https://api.commandcode.ai/provider/v1/chat/completions";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

const originalFetch = global.fetch;

function jsonResponse(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let captured;

beforeEach(() => {
  captured = [];
  mocks.fetch.mockReset();
  global.fetch = mocks.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

async function loadValidateRoute() {
  vi.resetModules();
  return import("../../src/app/api/providers/validate/route.js");
}

describe("commandcode key validation (/api/providers/validate)", () => {
  it("probes the provider API with stream:true, not the CLI /alpha/generate transport", async () => {
    mocks.fetch.mockImplementation((url, init) => {
      captured.push({ url: String(url), init });
      return Promise.resolve(jsonResponse(200));
    });

    const { POST } = await loadValidateRoute();
    const req = new Request("http://local/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "commandcode", apiKey: "user_valid" }),
    });

    await POST(req);

    const call = captured.find((c) => c.url.includes("commandcode.ai"));
    expect(call, "expected a probe to commandcode.ai").toBeTruthy();
    expect(call.url).toBe(TEST_URL);
    // /alpha/generate answers 400 for good and bad keys alike — must not be used.
    expect(call.url).not.toContain("/alpha/generate");

    const sent = JSON.parse(call.init.body);
    expect(sent.stream).toBe(true);
    expect(sent.max_tokens).toBe(1);
    expect(sent.messages?.[0]?.role).toBe("user");
    expect(call.init.headers.Authorization).toBe("Bearer user_valid");
  });

  it("rejects an invalid key (upstream 401)", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(401, { error: { code: "UNAUTHORIZED" } }));

    const { POST } = await loadValidateRoute();
    const req = new Request("http://local/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "commandcode", apiKey: "user_bad" }),
    });

    const res = await POST(req);
    const body = await res.json();
    expect(body.valid).toBe(false);
  });

  it("accepts a valid key (upstream 200)", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200));

    const { POST } = await loadValidateRoute();
    const req = new Request("http://local/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "commandcode", apiKey: "user_good" }),
    });

    const res = await POST(req);
    const body = await res.json();
    expect(body.valid).toBe(true);
  });
});
