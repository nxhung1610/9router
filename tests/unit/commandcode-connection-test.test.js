/**
 * Command Code "Test connection" button semantics.
 *
 * Regression: provider `commandcode` had no case in testApiKeyConnection(), so the
 * dashboard button returned { valid:false, error:"Provider test not supported" }.
 * The probe must hit the provider API with stream:true — the /alpha/generate transport
 * replies 400 "Proxy use detected" for a valid and an invalid key alike.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TEST_URL = "https://api.commandcode.ai/provider/v1/chat/completions";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  testProxyUrl: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/lib/network/proxyTest", () => ({
  testProxyUrl: mocks.testProxyUrl,
}));

const originalFetch = global.fetch;
const fetchMock = vi.fn();

const CONNECTION = {
  id: "conn-cc",
  provider: "commandcode",
  authType: "apikey",
  apiKey: "user_test_key",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderConnectionById.mockResolvedValue({ ...CONNECTION });
  mocks.updateProviderConnection.mockResolvedValue({});
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  global.fetch = fetchMock;
  fetchMock.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
});

async function runTest() {
  vi.resetModules();
  const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
  return testSingleConnection(CONNECTION.id);
}

describe("commandcode connection test", () => {
  it("is supported (does not report 'Provider test not supported')", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await runTest();

    expect(result.error).not.toBe("Provider test not supported");
    expect(result.valid).toBe(true);
  });

  it("probes the provider API with stream:true", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await runTest();

    const call = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes("commandcode.ai"));
    expect(call).toBe(TEST_URL);

    const init = fetchMock.mock.calls.find((c) => String(c[0]) === TEST_URL)?.[1];
    const sent = JSON.parse(init.body);
    expect(sent.stream).toBe(true);
    expect(init.headers.Authorization).toBe("Bearer user_test_key");
  });

  it("reports an invalid key as invalid", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401 }));

    const result = await runTest();

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/invalid api key/i);
  });
});
