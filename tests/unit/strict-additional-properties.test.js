import { describe, it, expect } from "vitest";
import { openaiToOpenAIResponsesRequest } from "open-sse/translator/request/openai-responses.js";

// Bug that shipped in 3384530 and was found by reading its own 400s:
// `schemaMissesRequired` only checked that every `properties` key appears in
// `required`. OpenAI strict mode demands a SECOND thing — `additionalProperties`
// must be literally `false` — so a schema with a complete `required` and no
// `additionalProperties` was judged strict-compliant, the mapper emitted
// `strict: true`, and upstream answered:
//   400 Invalid schema for response_format 't': In context=(), 'additionalProperties'
//   is required to be supplied and to be false.
// Measured live on cx/gpt-5.6-luna: missing additionalProperties -> 400,
// present and false -> 200. Same schema, only that one key differing.

function strictOf(schema, clientStrict) {
  const rf = {
    type: "json_schema",
    json_schema: { name: "t", schema, ...(clientStrict === undefined ? {} : { strict: clientStrict }) },
  };
  const out = openaiToOpenAIResponsesRequest("gpt-x", { messages: [{ role: "user", content: "hi" }], response_format: rf }, false);
  return out.text?.format?.strict;
}

const FULL_REQUIRED_NO_ADDITIONAL = {
  type: "object",
  properties: { a: { type: "string" } },
  required: ["a"],
};

const FULL_REQUIRED_WITH_ADDITIONAL = {
  type: "object",
  properties: { a: { type: "string" } },
  required: ["a"],
  additionalProperties: false,
};

const MISSING_REQUIRED = {
  type: "object",
  properties: { a: { type: "string" }, b: { type: "string" } },
  required: ["a"],
  additionalProperties: false,
};

describe("strict: additionalProperties la dieu kien THU HAI (bug da ship)", () => {
  it("required du NHUNG thieu additionalProperties => strict FALSE (khong 400)", () => {
    expect(strictOf(FULL_REQUIRED_NO_ADDITIONAL)).toBe(false);
  });

  it("required du VA additionalProperties:false => strict TRUE (enforce that)", () => {
    expect(strictOf(FULL_REQUIRED_WITH_ADDITIONAL)).toBe(true);
  });

  it("thieu required van strict FALSE du co additionalProperties", () => {
    expect(strictOf(MISSING_REQUIRED)).toBe(false);
  });

  it("object khong khai bao properties ma thieu additionalProperties => FALSE", () => {
    expect(strictOf({ type: "object" })).toBe(false);
  });

  it("nested object cung phai tuan ca hai dieu", () => {
    expect(strictOf({
      type: "object",
      properties: { inner: { type: "object", properties: { x: { type: "string" } }, required: ["x"] } },
      required: ["inner"],
      additionalProperties: false,
    })).toBe(false); // inner thieu additionalProperties
  });

  it("client gui strict:true van duoc ton trong (trach nhiem cua caller)", () => {
    expect(strictOf(FULL_REQUIRED_NO_ADDITIONAL, true)).toBe(true);
  });

  it("client gui strict:false van duoc ton trong", () => {
    expect(strictOf(FULL_REQUIRED_WITH_ADDITIONAL, false)).toBe(false);
  });

  it("schema trong $defs cung duoc kiem (de quy)", () => {
    expect(strictOf({
      type: "object",
      properties: { a: { $ref: "#/$defs/inner" } },
      required: ["a"],
      additionalProperties: false,
      $defs: { inner: { type: "object", properties: { y: { type: "string" } }, required: ["y"] } },
    })).toBe(false);
  });
});
