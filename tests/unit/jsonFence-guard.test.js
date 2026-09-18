import { describe, it, expect } from "vitest";
import { translateRequest } from "open-sse/translator/index.js";
import { wantsJsonOutput } from "open-sse/utils/jsonFence.js";

// Guard cua unfenceJsonChoices dua vao `body` — payload GOC cua client
// (chatCore truyen `body`, khong phai `translatedBody`). Neu translateRequest
// xoa `response_format` khoi body goc thi fence KHONG BAO GIO duoc go.
// Test nay khoa hanh vi do lai.
const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };

describe("body goc van giu response_format sau khi translate", () => {
  it("nhanh messages[] -> Responses", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { name: "x", strict: true, schema: SCHEMA } },
    };
    const original = structuredClone(body);

    const out = translateRequest("openai", "openai-responses", "m", body, false, null);

    // body goc PHAI con nguyen response_format (guard cua fence dua vao no)
    expect(body).toEqual(original);
    expect(wantsJsonOutput(body)).toBe(true);
    // con translated body thi da map sang text.format
    expect(out.text.format.type).toBe("json_schema");
    expect("response_format" in out).toBe(false);
  });

  it("nhanh input[] -> Responses", () => {
    const body = {
      input: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    };
    const original = structuredClone(body);

    translateRequest("openai", "openai-responses", "m", body, false, null);

    expect(body).toEqual(original);
    expect(wantsJsonOutput(body)).toBe(true);
  });

  it("Responses-native text.format cung duoc guard nhan ra", () => {
    const body = {
      input: "hi",
      text: { format: { type: "json_schema", name: "x", strict: true, schema: SCHEMA } },
    };
    translateRequest("openai-responses", "openai", "m", body, false, null);
    expect(wantsJsonOutput(body)).toBe(true);
  });
});
