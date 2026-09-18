import { describe, it, expect } from "vitest";
import { translateRequest } from "open-sse/translator/index.js";

// Test qua dung duong registry (translateRequest positional signature), de bat loi
// wiring: neu ai do bo mapping khoi registry/export thi test nay do.
const SCHEMA = {
  type: "object",
  properties: {
    zzz_cities: { type: "array", items: { type: "string" } },
  },
  required: ["zzz_cities"],
  additionalProperties: false,
};

// translateRequest(sourceFormat, targetFormat, model, body, stream, credentials, ...)
function tf(from, to, body) {
  return translateRequest(from, to, "gpt-5.6-luna", body, false, null);
}

describe("pipeline that: Chat -> Responses qua translateRequest", () => {
  it("response_format di qua duoc registry va thanh text.format", () => {
    const body = tf("openai", "openai-responses", {
      messages: [{ role: "user", content: "Neu 3 thanh pho" }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "Cities", strict: true, schema: SCHEMA },
      },
    });

    expect(body.text).toBeDefined();
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.schema).toEqual(SCHEMA);
    expect(body.text.format.name).toBe("Cities");
    expect("response_format" in body).toBe(false);
  });

  it("khong co response_format => khong sinh text rac", () => {
    const body = tf("openai", "openai-responses", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect("text" in body).toBe(false);
  });

  it("pipeline nguoc: Responses -> Chat map nguoc va xoa text", () => {
    const body = tf("openai-responses", "openai", {
      input: [{ role: "user", content: "hi" }],
      text: { format: { type: "json_schema", name: "Cities", strict: true, schema: SCHEMA } },
    });

    expect(body.response_format?.type).toBe("json_schema");
    expect(body.response_format?.json_schema?.schema).toEqual(SCHEMA);
    expect("text" in body).toBe(false);
  });
});
