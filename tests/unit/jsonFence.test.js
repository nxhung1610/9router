import { describe, it, expect } from "vitest";
import {
  wantsJsonOutput,
  stripJsonFence,
  unfenceJsonChoices,
} from "open-sse/utils/jsonFence.js";

const RF_SCHEMA = { type: "json_schema", json_schema: { name: "x", schema: { type: "object" } } };

describe("wantsJsonOutput", () => {
  it("nhan Chat Completions response_format", () => {
    expect(wantsJsonOutput({ response_format: RF_SCHEMA })).toBe(true);
    expect(wantsJsonOutput({ response_format: { type: "json_object" } })).toBe(true);
  });

  it("nhan ca Responses text.format", () => {
    expect(wantsJsonOutput({ text: { format: { type: "json_schema" } } })).toBe(true);
    expect(wantsJsonOutput({ text: { format: { type: "json_object" } } })).toBe(true);
  });

  it("khong yeu cau JSON => false", () => {
    expect(wantsJsonOutput({})).toBe(false);
    expect(wantsJsonOutput({ response_format: { type: "text" } })).toBe(false);
    expect(wantsJsonOutput({ text: { format: { type: "text" } } })).toBe(false);
    expect(wantsJsonOutput(null)).toBe(false);
    expect(wantsJsonOutput(undefined)).toBe(false);
  });
});

describe("stripJsonFence", () => {
  it("bo fence ```json", () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("bo fence khong co nhan ngon ngu", () => {
    expect(stripJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("bo fence JSON viet hoa", () => {
    expect(stripJsonFence('```JSON\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("ho tro CRLF", () => {
    expect(stripJsonFence('```json\r\n{"a":1}\r\n```')).toBe('{"a":1}');
  });

  it("JSON thuan (khong fence) giu nguyen", () => {
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });

  it("cau tra loi thuong KHONG bi dung", () => {
    const prose = "Đây là ví dụ:\n```json\n{\"a\":1}\n```\nHết.";
    expect(stripJsonFence(prose)).toBe(prose);
  });

  it("text thuan giu nguyen", () => {
    expect(stripJsonFence("Hà Nội, Đà Nẵng")).toBe("Hà Nội, Đà Nẵng");
  });

  it("null / non-string giu nguyen (khong crash)", () => {
    expect(stripJsonFence(null)).toBe(null);
    expect(stripJsonFence(undefined)).toBe(undefined);
    expect(stripJsonFence(123)).toBe(123);
    expect(stripJsonFence({ a: 1 })).toEqual({ a: 1 });
  });

  it("fence chua code khong phai JSON: chi khi TOAN BO content la 1 block", () => {
    // Dung 1 fenced block => go fence (dung nhu thiet ke)
    expect(stripJsonFence('```json\n[1,2,3]\n```')).toBe('[1,2,3]');
  });

  it("2 fenced block lien nhau => KHONG go (khong phai 1 block duy nhat)", () => {
    const two = '```json\n{"a":1}\n```\n```json\n{"b":2}\n```';
    expect(stripJsonFence(two)).toBe(two);
  });
});

describe("unfenceJsonChoices", () => {
  const mkResp = (content) => ({
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });

  it("go fence khi client xin JSON", () => {
    const resp = mkResp('```json\n{"ok":true}\n```');
    unfenceJsonChoices({ response_format: RF_SCHEMA }, resp);
    expect(resp.choices[0].message.content).toBe('{"ok":true}');
  });

  it("KHONG go fence khi client khong xin JSON", () => {
    const resp = mkResp('```json\n{"ok":true}\n```');
    unfenceJsonChoices({}, resp);
    expect(resp.choices[0].message.content).toBe('```json\n{"ok":true}\n```');
  });

  it("cau tra loi thuong co code block KHONG bi dung", () => {
    const prose = 'Ví dụ:\n```js\nconsole.log(1)\n```';
    const resp = mkResp(prose);
    unfenceJsonChoices({ response_format: RF_SCHEMA }, resp);
    expect(resp.choices[0].message.content).toBe(prose);
  });

  it("nhieu choice deu duoc xu ly", () => {
    const resp = {
      choices: [
        { index: 0, message: { content: '```json\n{"a":1}\n```' } },
        { index: 1, message: { content: '```json\n{"b":2}\n```' } },
      ],
    };
    unfenceJsonChoices({ response_format: { type: "json_object" } }, resp);
    expect(resp.choices[0].message.content).toBe('{"a":1}');
    expect(resp.choices[1].message.content).toBe('{"b":2}');
  });

  it("content null khong crash", () => {
    const resp = mkResp(null);
    unfenceJsonChoices({ response_format: RF_SCHEMA }, resp);
    expect(resp.choices[0].message.content).toBe(null);
  });

  it("response khong co choices => tra nguyen, khong crash", () => {
    const resp = { object: "response", output: [] };
    expect(unfenceJsonChoices({ response_format: RF_SCHEMA }, resp)).toBe(resp);
    expect(unfenceJsonChoices({ response_format: RF_SCHEMA }, null)).toBe(null);
  });

  it("message khong co content van an toan", () => {
    const resp = { choices: [{ index: 0, message: { role: "assistant" } }] };
    unfenceJsonChoices({ response_format: RF_SCHEMA }, resp);
    expect(resp.choices[0].message.content).toBe(undefined);
  });
});

// Enhancement 3 phai phu CA HAI shape: choices[] (Chat client) va output[]
// (client goi /v1/responses nhung provider chi noi Chat). Chi xu ly choices[]
// de lai lo hong im lang — da do duoc: fence van con nguyen trong output[].text.
describe("Enh3: unfenceJsonChoices phu ca 2 shape", () => {
  const BODY = { response_format: { type: "json_object" } };
  const withFence = () => ({
    choices: [{ message: { role: "assistant", content: '```json\n{"a":1}\n```' } }],
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "```json\n{\"r\":2}\n```" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: '```json\n{"a":1}\n```', annotations: [] }] },
      { type: "output_text", text: "```json\n{\"top\":3}\n```" },
    ],
  });

  it("go fence o choices[].message.content", async () => {
    const { unfenceJsonChoices } = await import("open-sse/utils/jsonFence.js");
    const r = unfenceJsonChoices(BODY, withFence());
    expect(r.choices[0].message.content).toBe('{"a":1}');
  });

  it("go fence o output[].content[].text khi type=output_text", async () => {
    const { unfenceJsonChoices } = await import("open-sse/utils/jsonFence.js");
    const r = unfenceJsonChoices(BODY, withFence());
    expect(r.output[1].content[0].text).toBe('{"a":1}');
  });

  it("KHONG dong vao reasoning summary (do la suy luan, khong phai cau tra loi)", async () => {
    const { unfenceJsonChoices } = await import("open-sse/utils/jsonFence.js");
    const r = unfenceJsonChoices(BODY, withFence());
    expect(r.output[0].summary[0].text).toBe('```json\n{"r":2}\n```');
  });

  it("KHONG dong vao output_text nam truc tiep trong output[] (khong phai item.content)", async () => {
    const { unfenceJsonChoices } = await import("open-sse/utils/jsonFence.js");
    const r = unfenceJsonChoices(BODY, withFence());
    expect(r.output[2].text).toBe('```json\n{"top":3}\n```');
  });

  it("khong co response_format => ca 2 shape giu nguyen fence", async () => {
    const { unfenceJsonChoices } = await import("open-sse/utils/jsonFence.js");
    const r = unfenceJsonChoices({}, withFence());
    expect(r.choices[0].message.content).toBe('```json\n{"a":1}\n```');
    expect(r.output[1].content[0].text).toBe('```json\n{"a":1}\n```');
  });
});
