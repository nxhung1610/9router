import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

const encoder = new TextEncoder();

function sseResponse(lines, headers = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines.concat("data: [DONE]", "").join("\n\n")));
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream", ...headers } });
}

function baseCtx(providerResponse, overrides = {}) {
  return {
    providerResponse,
    sourceFormat: FORMATS.CLAUDE,
    targetFormat: FORMATS.OPENAI,
    provider: "op-test-chat",
    model: "requested-model",
    body: { model: "requested-model", messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    apiKey: "test-key",
    clientRawRequest: { endpoint: "/v1/messages" },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    ...overrides
  };
}

const CHAT_SSE = [
  'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"upstream-model","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"upstream-model","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"shell","arguments":"{\\"cmd\\":\\"pwd\\"}"}}]},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"upstream-model","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}'
];

const RESPONSES_SSE = [
  'event: response.created\ndata: {"response":{"id":"resp_1","created_at":1700000000}}',
  'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"reasoning","summary":[{"type":"summary_text","text":"thinking"}]}}',
  'event: response.output_item.done\ndata: {"output_index":1,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}',
  'event: response.output_item.done\ndata: {"output_index":2,"item":{"type":"function_call","call_id":"call_9","name":"shell","arguments":"{\\"cmd\\":\\"pwd\\"}"}}',
  'event: response.completed\ndata: {"response":{"id":"resp_1","model":"upstream-model","status":"completed","usage":{"input_tokens":8,"output_tokens":5,"cached_tokens":2}}}'
];

describe("forced-SSE JSON path for a Claude client", () => {
  it("returns an Anthropic Message from a Chat Completions upstream", async () => {
    const result = await handleForcedSSEToJson(baseCtx(sseResponse(CHAT_SSE)));
    expect(result.success).toBe(true);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    const json = await result.response.json();
    expect(json).toMatchObject({ type: "message", role: "assistant", model: "requested-model", stop_reason: "tool_use" });
    expect(json.object).toBeUndefined();
    expect(json.choices).toBeUndefined();
    expect(json.content).toEqual([
      { type: "text", text: "hi" },
      { type: "tool_use", id: "call_9", name: "shell", input: { cmd: "pwd" } }
    ]);
    expect(json.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });

  it("preserves request-id and Anthropic rate-limit metadata but strips SSE framing headers", async () => {
    const result = await handleForcedSSEToJson(baseCtx(sseResponse(CHAT_SSE, {
      "request-id": "req-test-123",
      "anthropic-ratelimit-requests-limit": "100",
      "content-length": "9999",
      "content-encoding": "gzip",
      "transfer-encoding": "chunked",
      "connection": "keep-alive"
    })));
    expect(result.success).toBe(true);
    expect(result.response.headers.get("request-id")).toBe("req-test-123");
    expect(result.response.headers.get("anthropic-ratelimit-requests-limit")).toBe("100");
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(result.response.headers.get("content-length")).toBeNull();
    expect(result.response.headers.get("content-encoding")).toBeNull();
    expect(result.response.headers.get("transfer-encoding")).toBeNull();
    expect(result.response.headers.get("connection")).toBeNull();
  });

  it("returns an Anthropic Message from a Responses API upstream", async () => {
    const result = await handleForcedSSEToJson(baseCtx(sseResponse(RESPONSES_SSE), {
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex"
    }));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json).toMatchObject({ type: "message", role: "assistant", model: "requested-model", stop_reason: "tool_use" });
    expect(json.output).toBeUndefined();
    expect(json.content).toEqual([
      { type: "thinking", thinking: "thinking" },
      { type: "text", text: "hi" },
      { type: "tool_use", id: "call_9", name: "shell", input: { cmd: "pwd" } }
    ]);
    expect(json.usage).toMatchObject({ input_tokens: 8, output_tokens: 5 });
  });

  it("strips a whole-content ```json fence before building the Claude message from a Responses upstream", async () => {
    const fenced = [
      'event: response.created\ndata: {"response":{"id":"resp_2","created_at":1700000000}}',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"```json\\n{\\"a\\":1}\\n```"}]}}',
      'event: response.completed\ndata: {"response":{"id":"resp_2","status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}'
    ];
    const result = await handleForcedSSEToJson(baseCtx(sseResponse(fenced), {
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex",
      body: { model: "requested-model", messages: [], response_format: { type: "json_object" } }
    }));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.content).toEqual([{ type: "text", text: '{"a":1}' }]);
  });

  it("keeps a plain OpenAI client in Chat Completions format", async () => {
    const result = await handleForcedSSEToJson(baseCtx(sseResponse(CHAT_SSE), {
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI
    }));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("hi");
  });

  it("still returns a Claude Message on the normal non-streaming path", () => {
    const translated = translateNonStreamingResponse({
      id: "chatcmpl-normal",
      model: "upstream-model",
      choices: [{ finish_reason: "length", message: { content: "ok" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 }
    }, FORMATS.OPENAI, FORMATS.CLAUDE);
    expect(translated).toMatchObject({
      type: "message", model: "upstream-model", stop_reason: "max_tokens",
      content: [{ type: "text", text: "ok" }]
    });
  });

  it("returns HTTP 502 (not a 200 shell) when the forced SSE carries no data frame at all", async () => {
    const result = await handleForcedSSEToJson(baseCtx(sseResponse(["event: ping"]), {
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI
    }));
    expect(result.success).toBe(false);
    expect(result.response.status).toBe(502);
    expect(result.response.headers.get("content-type")).toContain("application/json");
  });

  it("turns a content-less forced SSE into a well-formed (empty) Anthropic Message, never raw OpenAI JSON", async () => {
    const result = await handleForcedSSEToJson(baseCtx(sseResponse(['data: {"type":"ping"}'])));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "" }] });
    expect(json.object).toBeUndefined();
    expect(json.choices).toBeUndefined();
  });
});
