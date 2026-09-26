import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
const mockFetch = vi.fn(async (_url, _options) => new Response("ok", { status: 200 }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => mockFetch(...args),
}));

beforeEach(() => mockFetch.mockClear());

describe("Codex request-specific URL state", () => {
  it("does not carry compact routing into the following regular request", async () => {
    const executor = new CodexExecutor();
    executor.config.baseUrl = "https://codex.example/responses";
    const args = (body) => ({
      model: "gpt-5.5",
      body,
      stream: true,
      credentials: { connectionId: "conn_test", accessToken: "test-token" },
      signal: undefined,
      log: undefined,
    });

    await executor.execute(args({ _compact: true, input: [{ role: "user", content: "compact" }] }));
    await executor.execute(args({ input: [{ role: "user", content: "regular" }] }));

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://codex.example/responses/compact",
      "https://codex.example/responses",
    ]);
  });

  it("binds the outbound session header to the request's cache key, not a shared default", async () => {
    const executor = new CodexExecutor();
    executor.config.baseUrl = "https://codex.example/responses";
    const body = { input: [{ role: "user", content: "capture session semantics" }] };
    await executor.execute({
      model: "gpt-5.5",
      body,
      stream: true,
      credentials: { connectionId: "conn_test", accessToken: "test-token" },
    });

    const [, options] = mockFetch.mock.calls[0];
    const sent = JSON.parse(options.body);
    expect(options.headers.session_id).toBe(sent.prompt_cache_key);
    expect(options.headers.session_id).not.toBe("default");
  });

  it("does not emit the literal default session when headers are built without cached executor state", () => {
    const executor = new CodexExecutor();
    const headers = executor.buildHeaders({
      connectionId: "conn_test",
      accessToken: "test-token",
      providerSpecificData: {},
    });

    expect(headers.session_id).not.toBe("default");
    expect(headers.session_id).toBeTruthy();
  });

  it("preserves compact routing across the outer SSE-overload retry", async () => {
    const executor = new CodexExecutor();
    executor.config.baseUrl = "https://codex.example/responses";
    executor.config.retry = { 503: { attempts: 1, delayMs: 0 } };
    mockFetch
      .mockResolvedValueOnce(new Response('event: error\\ndata: {"error":{"type":"server_is_overloaded","message":"retry"}}\\n\\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }))
      .mockResolvedValueOnce(new Response('event: response.completed\\ndata: {"type":"response.completed"}\\n\\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }));

    await executor.execute({
      model: "gpt-5.5",
      body: { _compact: true, input: [{ role: "user", content: "compact" }] },
      stream: true,
      credentials: { connectionId: "conn_test", accessToken: "test-token" },
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://codex.example/responses/compact",
      "https://codex.example/responses/compact",
    ]);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).not.toHaveProperty("_compact");
  });

  it("uses the current request's compact flag for routing", async () => {
    const executor = new CodexExecutor();
    executor.config.baseUrl = "https://codex.example/responses";
    const args = (body) => ({
      model: "gpt-5.5",
      body,
      stream: true,
      credentials: { connectionId: "conn_test", accessToken: "test-token" },
      signal: undefined,
      log: undefined,
    });

    await executor.execute(args({ input: [{ role: "user", content: "regular" }] }));
    await executor.execute(args({ _compact: true, input: [{ role: "user", content: "compact" }] }));

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://codex.example/responses",
      "https://codex.example/responses/compact",
    ]);
  });
});
