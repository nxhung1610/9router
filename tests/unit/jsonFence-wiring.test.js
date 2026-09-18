import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

const RF_SCHEMA = {
  type: "json_schema",
  json_schema: { name: "cities", strict: true, schema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } }
};

// Upstream tra ve object JSON nhung BOC trong fence ```json (Claude-backed
// provider nhan schema qua prompt nen hay lam vay).
const FENCED = '```json\n{"cities":["Hà Nội"]}\n```';

// --- 1. duong non-stream that (handleNonStreamingResponse) ---
function nonStreamCtx(body) {
  const upstream = {
    id: "chatcmpl-x",
    object: "chat.completion",
    created: 1700000000,
    model: "cl/opus",
    choices: [{ index: 0, message: { role: "assistant", content: FENCED }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  };
  return {
    providerResponse: new Response(JSON.stringify(upstream), { headers: { "content-type": "application/json" } }),
    provider: "cl",
    model: "claude-opus-5",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    body,
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    reqLogger: { logConvertedResponse: vi.fn(), logProviderResponse: vi.fn(), logRequest: vi.fn() },
    toolNameMap: null,
    customToolNames: null,
    trackDone: vi.fn(),
    appendLog: vi.fn()
  };
}

describe("WIRING: non-stream handler go fence khi client xin JSON", () => {
  it("co response_format json_schema => fence duoc go", async () => {
    const res = await handleNonStreamingResponse(nonStreamCtx({ model: "cl/opus", messages: [], response_format: RF_SCHEMA }));
    expect(res.success).toBe(true);
    const json = await res.response.json();
    expect(json.choices[0].message.content).toBe('{"cities":["Hà Nội"]}');
  });

  it("KHONG co response_format => fence giu nguyen", async () => {
    const res = await handleNonStreamingResponse(nonStreamCtx({ model: "cl/opus", messages: [] }));
    const json = await res.response.json();
    expect(json.choices[0].message.content).toBe(FENCED);
  });

  it("Responses-native text.format cung kich hoat guard", async () => {
    const res = await handleNonStreamingResponse(nonStreamCtx({
      model: "cl/opus",
      messages: [],
      text: { format: { type: "json_schema", name: "cities", schema: { type: "object" } } }
    }));
    const json = await res.response.json();
    expect(json.choices[0].message.content).toBe('{"cities":["Hà Nội"]}');
  });

  it("client goi /v1/responses (provider chi noi Chat) => go fence trong output[]", async () => {
    // Duong nay di qua openAICompletionToResponses(): content duoc COPY vao
    // output[].content[].text. Neu chi unfence choices[] truoc khi convert thi
    // fence van con trong ket qua client doc.
    const res = await handleNonStreamingResponse({
      ...nonStreamCtx({ model: "cl/opus", messages: [], response_format: RF_SCHEMA }),
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      clientRawRequest: { endpoint: "/v1/responses" },
    });
    expect(res.success).toBe(true);
    const json = await res.response.json();
    const part = json.output?.find((i) => i.type === "message")?.content?.find((c) => c.type === "output_text");
    expect(part?.text).toBe('{"cities":["Hà Nội"]}');
  });
});

// --- 2. duong forced SSE -> JSON (client chat, provider stream) ---
function sseCtx(body) {
  const encoder = new TextEncoder();
  const raw = [
    `data: ${JSON.stringify({ id: "chatcmpl-s", object: "chat.completion.chunk", created: 1700000000, model: "gpt-x", choices: [{ delta: { role: "assistant", content: '```json\n{"a":1}\n```' }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: "chatcmpl-s", object: "chat.completion.chunk", created: 1700000000, model: "gpt-x", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]",
    ""
  ].join("\n\n");
  return {
    providerResponse: new Response(new ReadableStream({
      start(c) { c.enqueue(encoder.encode(raw)); c.close(); }
    }), { headers: { "content-type": "text/event-stream" } }),
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    provider: "op-test-chat",
    model: "gpt-x",
    body,
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    trackDone: vi.fn(),
    appendLog: vi.fn()
  };
}

describe("WIRING: forced SSE->JSON handler go fence khi client xin JSON", () => {
  it("co response_format => fence duoc go", async () => {
    const res = await handleForcedSSEToJson(sseCtx({ model: "gpt-x", messages: [], response_format: RF_SCHEMA }));
    expect(res.success).toBe(true);
    const json = await res.response.json();
    expect(json.choices[0].message.content).toBe('{"a":1}');
  });

  it("KHONG co response_format => fence giu nguyen", async () => {
    const res = await handleForcedSSEToJson(sseCtx({ model: "gpt-x", messages: [] }));
    const json = await res.response.json();
    expect(json.choices[0].message.content).toBe('```json\n{"a":1}\n```');
  });
});
