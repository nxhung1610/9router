import { describe, it, expect } from "vitest";
import {
  openaiToOpenAIResponsesRequest,
  openaiResponsesToOpenAIRequest,
} from "open-sse/translator/request/openai-responses.js";

// Schema strict-compliant: moi property deu nam trong `required`
const SCHEMA_FULL = {
  type: "object",
  properties: { zzz_cities: { type: "array", items: { type: "string" } } },
  required: ["zzz_cities"],
  additionalProperties: false,
};

describe("resolveStrict — khong gui schema bat kha thi cho upstream", () => {
  const build = (schema, strict) => {
    const json_schema = { name: "c", schema };
    if (strict !== undefined) json_schema.strict = strict;
    const out = openaiToOpenAIResponsesRequest(
      "m",
      { messages: [{ role: "user", content: "hi" }], response_format: { type: "json_schema", json_schema } },
      false,
      {}
    );
    return out.text.format.strict;
  };

  it("schema fully-required + khong gui strict => strict true", () => {
    expect(build(SCHEMA_FULL)).toBe(true);
  });

  it("schema CO optional property + khong gui strict => ha xuong false (tranh 400)", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    expect(build(schema)).toBe(false);
  });

  it("thieu han `required` => false", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    expect(build(schema)).toBe(false);
  });

  it("client gui strict:true => ton trong true (du schema co optional)", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    expect(build(schema, true)).toBe(true);
  });

  it("client gui strict:false => false (du schema fully-required)", () => {
    expect(build(SCHEMA_FULL, false)).toBe(false);
  });

  it("optional property nam sau nested object => van phat hien", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: { x: { type: "string" }, y: { type: "string" } },
          required: ["x"],
          additionalProperties: false,
        },
      },
      required: ["outer"],
      additionalProperties: false,
    };
    expect(build(schema)).toBe(false);
  });

  it("optional property trong $defs => van phat hien", () => {
    const schema = {
      type: "object",
      properties: { ref: { $ref: "#/$defs/Inner" } },
      required: ["ref"],
      additionalProperties: false,
      $defs: {
        Inner: {
          type: "object",
          properties: { p: { type: "string" }, q: { type: "string" } },
          required: ["p"],
        },
      },
    };
    expect(build(schema)).toBe(false);
  });

  it("optional property trong items (array) => van phat hien", () => {
    const schema = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: {
            type: "object",
            properties: { p: { type: "string" }, q: { type: "string" } },
            required: ["p"],
          },
        },
      },
      required: ["list"],
      additionalProperties: false,
    };
    expect(build(schema)).toBe(false);
  });

  it("optional property trong anyOf => van phat hien", () => {
    const schema = {
      type: "object",
      properties: {
        v: {
          anyOf: [
            { type: "object", properties: { p: { type: "string" }, q: { type: "string" } }, required: ["p"] },
            { type: "null" },
          ],
        },
      },
      required: ["v"],
      additionalProperties: false,
    };
    expect(build(schema)).toBe(false);
  });

  it("schema long nhau deu required => false duoc giu nguyen strict true", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
          additionalProperties: false,
        },
      },
      required: ["outer"],
      additionalProperties: false,
    };
    expect(build(schema)).toBe(true);
  });

  it("additionalProperties:false (boolean) khong lam crash / khong bao sai", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    expect(build(schema)).toBe(true);
  });

  it("properties rong => khong coi la thieu required", () => {
    const schema = { type: "object", properties: {}, additionalProperties: false };
    expect(build(schema)).toBe(true);
  });
});

describe("resolveStrict — chieu NGUOC (Responses -> Chat) cung ap cung quy tac", () => {
  const buildRev = (schema, strict) => {
    const fmt = { type: "json_schema", name: "c", schema };
    if (strict !== undefined) fmt.strict = strict;
    const out = openaiResponsesToOpenAIRequest(
      "m",
      { input: "hi", text: { format: fmt } },
      false,
      {}
    );
    return out.response_format.json_schema.strict;
  };

  it("optional property + khong gui strict => false", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    expect(buildRev(schema)).toBe(false);
  });

  it("fully-required + khong gui strict => true", () => {
    expect(buildRev(SCHEMA_FULL)).toBe(true);
  });

  it("client gui strict:true => true", () => {
    expect(buildRev(SCHEMA_FULL, true)).toBe(true);
  });

  it("client gui strict:false => false", () => {
    expect(buildRev(SCHEMA_FULL, false)).toBe(false);
  });
});
