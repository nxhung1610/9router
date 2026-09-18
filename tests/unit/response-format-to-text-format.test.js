import { describe, it, expect } from "vitest";
import {
  openaiToOpenAIResponsesRequest,
  openaiResponsesToOpenAIRequest,
} from "open-sse/translator/request/openai-responses.js";

const SCHEMA = {
  type: "object",
  properties: {
    zzz_cities: { type: "array", items: { type: "string" } },
    zzz_n: { type: "integer" },
  },
  required: ["zzz_cities", "zzz_n"],
  additionalProperties: false,
};

const jsonSchemaRF = {
  type: "json_schema",
  json_schema: { name: "Cities", strict: true, schema: SCHEMA },
};

describe("Chat response_format -> Responses text.format (chieu di)", () => {
  it("json_schema duoc map sang text.format va flatten name/schema/strict", () => {
    const out = openaiToOpenAIResponsesRequest(
      "gpt-5.6-luna",
      { messages: [{ role: "user", content: "hi" }], response_format: jsonSchemaRF },
      false,
      {}
    );

    expect(out.text).toEqual({
      format: { type: "json_schema", name: "Cities", strict: true, schema: SCHEMA },
    });
    // Responses API khong co response_format -> phai bi xoa
    expect("response_format" in out).toBe(false);
  });

  it("json_object duoc map sang text.format", () => {
    const out = openaiToOpenAIResponsesRequest(
      "m",
      { messages: [{ role: "user", content: "hi" }], response_format: { type: "json_object" } },
      false,
      {}
    );
    expect(out.text).toEqual({ format: { type: "json_object" } });
    expect("response_format" in out).toBe(false);
  });

  it("text.format client gui san phai duoc giu (thang response_format)", () => {
    const explicit = { format: { type: "json_object" } };
    const out = openaiToOpenAIResponsesRequest(
      "m",
      {
        messages: [{ role: "user", content: "hi" }],
        text: explicit,
        response_format: jsonSchemaRF,
      },
      false,
      {}
    );
    // text.format cua client thang
    expect(out.text).toEqual(explicit);
  });

  it("khong gui response_format => khong them text", () => {
    const out = openaiToOpenAIResponsesRequest(
      "m",
      { messages: [{ role: "user", content: "hi" }] },
      false,
      {}
    );
    expect("text" in out).toBe(false);
  });

  it("strict: false phai duoc ton trong (khong ep thanh true)", () => {
    const out = openaiToOpenAIResponsesRequest(
      "m",
      {
        messages: [{ role: "user", content: "hi" }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "X", strict: false, schema: SCHEMA },
        },
      },
      false,
      {}
    );
    expect(out.text.format.strict).toBe(false);
  });

  it("json_schema thieu `schema` bi bo qua (khong tao text rac)", () => {
    const out = openaiToOpenAIResponsesRequest(
      "m",
      {
        messages: [{ role: "user", content: "hi" }],
        response_format: { type: "json_schema", json_schema: { name: "NoSchema" } },
      },
      false,
      {}
    );
    expect("text" in out).toBe(false);
  });

  it("nhanh input[] (Responses-native) cung map response_format va xoa no", () => {
    const out = openaiToOpenAIResponsesRequest(
      "m",
      {
        input: [{ role: "user", content: "hi" }],
        response_format: jsonSchemaRF,
      },
      false,
      {}
    );
    expect(out.text).toEqual({
      format: { type: "json_schema", name: "Cities", strict: true, schema: SCHEMA },
    });
    expect("response_format" in out).toBe(false);
  });
});

describe("Responses text.format -> Chat response_format (chieu nguoc)", () => {
  it("text.format json_schema duoc map nguoc va `text` bi xoa", () => {
    const out = openaiResponsesToOpenAIRequest(
      "m",
      {
        input: [{ role: "user", content: "hi" }],
        text: { format: { type: "json_schema", name: "Cities", strict: true, schema: SCHEMA } },
      },
      false,
      {}
    );

    expect(out.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "Cities", schema: SCHEMA, strict: true },
    });
    // `text` khong phai field Chat Completions -> khong duoc ro ra
    expect("text" in out).toBe(false);
  });

  it("text.format json_object map nguoc", () => {
    const out = openaiResponsesToOpenAIRequest(
      "m",
      { input: "hi", text: { format: { type: "json_object" } } },
      false,
      {}
    );
    expect(out.response_format).toEqual({ type: "json_object" });
    expect("text" in out).toBe(false);
  });

  it("response_format client gui san khong bi ghi de", () => {
    const out = openaiResponsesToOpenAIRequest(
      "m",
      {
        input: "hi",
        text: { format: { type: "json_object" } },
        response_format: jsonSchemaRF,
      },
      false,
      {}
    );
    expect(out.response_format).toEqual(jsonSchemaRF);
    expect("text" in out).toBe(false);
  });

  it("text.format la `text` (mac dinh) => khong sinh response_format", () => {
    const out = openaiResponsesToOpenAIRequest(
      "m",
      { input: "hi", text: { format: { type: "text" } } },
      false,
      {}
    );
    expect("response_format" in out).toBe(false);
    expect("text" in out).toBe(false);
  });
});
