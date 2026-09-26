import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

// Keep the real stream plumbing but spy on the handoff, so this file proves the
// HANDLER wires the keep-alive (a helper-only test stays green even when the
// handler stops passing pingBytes).
vi.mock("../../open-sse/utils/streamHandler.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    pipeWithDisconnect: vi.fn((...args) => actual.pipeWithDisconnect(...args))
  };
});

const { createDisconnectAwareStream, pipeWithDisconnect } = await import("../../open-sse/utils/streamHandler.js");
const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

function controllerStub() {
  let connected = true;
  return {
    isConnected: () => connected,
    handleComplete: vi.fn(() => { connected = false; }),
    handleDisconnect: vi.fn(() => { connected = false; }),
    handleError: vi.fn(() => { connected = false; }),
    disconnect: () => { connected = false; }
  };
}

function neverEndingStream() {
  return new ReadableStream({
    start() {},
    cancel() {}
  });
}

function chatSseResponse() {
  const body = [
    'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
    "data: [DONE]",
    ""
  ].join("\n\n");
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
    },
    cancel() {}
  }), { headers: { "content-type": "text/event-stream" } });
}

async function runHandler(sourceFormat) {
  const result = await handleStreamingResponse({
    providerResponse: chatSseResponse(),
    provider: "opencode",
    model: "some-model",
    sourceFormat,
    targetFormat: FORMATS.OPENAI,
    body: { model: "some-model", messages: [{ role: "user", content: "hi" }] },
    stream: true,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    apiKey: "test-key",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    streamController: controllerStub(),
    reqTag: "test",
    log: null
  });
  // Release the stall timer / intervals this stream holds.
  await result.response.body.cancel().catch(() => {});
  return result;
}

describe("Claude SSE idle keep-alive", () => {
  it("emits Anthropic event: ping while the upstream/transform is silent", async () => {
    vi.useFakeTimers();
    const ping = new TextEncoder().encode('event: ping\ndata: {"type": "ping"}\n\n');
    const streamController = controllerStub();
    const out = createDisconnectAwareStream(
      { readable: neverEndingStream(), writable: { getWriter: () => ({ abort: vi.fn() }) } },
      streamController,
      null,
      ping,
      15000
    );
    const reader = out.getReader();
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(15000);
    const { value, done } = await first;
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toBe('event: ping\ndata: {"type": "ping"}\n\n');
    await reader.cancel();
    vi.useRealTimers();
  });

  it("does not emit keep-alive when not requested", async () => {
    const streamController = controllerStub();
    const source = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: real\n\n")); controller.close(); }
    });
    const out = createDisconnectAwareStream(
      { readable: source, writable: { getWriter: () => ({ abort: vi.fn() }) } },
      streamController
    );
    const reader = out.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("data: real\n\n");
    await reader.read();
  });

  it("wires the keep-alive for a Claude client through handleStreamingResponse", async () => {
    pipeWithDisconnect.mockClear();
    await runHandler(FORMATS.CLAUDE);
    expect(pipeWithDisconnect).toHaveBeenCalledTimes(1);
    const pingBytes = pipeWithDisconnect.mock.calls[0][5];
    expect(pingBytes).toBeTruthy();
    expect(new TextDecoder().decode(pingBytes)).toBe('event: ping\ndata: {"type": "ping"}\n\n');
  });

  it("does not wire a keep-alive for a non-Claude client", async () => {
    pipeWithDisconnect.mockClear();
    await runHandler(FORMATS.OPENAI);
    expect(pipeWithDisconnect).toHaveBeenCalledTimes(1);
    expect(pipeWithDisconnect.mock.calls[0][5]).toBeNull();
  });
});
