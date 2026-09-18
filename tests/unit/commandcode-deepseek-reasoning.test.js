/**
 * Regression tests: DeepSeek thinking mode on Command Code needs the reasoning of every
 * tool-call turn echoed back, otherwise upstream rejects the request with
 *   "The `reasoning_content` in the thinking mode must be passed back to the API."
 *
 * Verified live against https://api.commandcode.ai/alpha/generate (2026-09-10):
 *  - `{type:"reasoning", text}` is accepted (placeholder " " is enough).
 *  - `{type:"thinking"}` / `{type:"redacted_thinking"}` are REJECTED by the ModelMessage[] schema.
 *  - Kimi K2.6 / GLM-5.1 accept the same payload with or without the block.
 */

import { describe, it, expect } from "vitest";
import { openaiToCommandCodeRequest } from "../../open-sse/translator/request/openai-to-commandcode.js";

const DEEPSEEK = "deepseek/deepseek-v4.1-flash";
const KIMI = "moonshotai/Kimi-K2.6";

const toolCallTurn = (extra = {}) => ({
  role: "assistant",
  content: "",
  tool_calls: [
    { id: "call_1", type: "function", function: { name: "list_dir", arguments: '{"path":"."}' } },
  ],
  ...extra,
});

const toolResult = { role: "tool", tool_call_id: "call_1", name: "list_dir", content: "a.txt" };

const messagesFor = () => [
  { role: "user", content: "List files." },
  toolCallTurn(),
  toolResult,
];

describe("openaiToCommandCodeRequest — DeepSeek reasoning echo", () => {
  it("prepends a reasoning block to a tool-call turn", () => {
    const out = openaiToCommandCodeRequest(DEEPSEEK, { messages: messagesFor() }, true);
    const assistant = out.params.messages.find((m) => m.role === "assistant");

    expect(assistant.content[0].type).toBe("reasoning");
    expect(typeof assistant.content[0].text).toBe("string");
    expect(assistant.content[0].text.length).toBeGreaterThan(0);
  });

  it("keeps the reasoning block ahead of the tool-call block", () => {
    const out = openaiToCommandCodeRequest(DEEPSEEK, { messages: messagesFor() }, true);
    const types = out.params.messages.find((m) => m.role === "assistant").content.map((b) => b.type);

    expect(types[0]).toBe("reasoning");
    expect(types).toContain("tool-call");
  });

  it("echoes the client's reasoning_content when present instead of the placeholder", () => {
    const out = openaiToCommandCodeRequest(DEEPSEEK, {
      messages: [
        { role: "user", content: "List files." },
        toolCallTurn({ reasoning_content: "I should call list_dir." }),
        toolResult,
      ],
    }, true);

    const assistant = out.params.messages.find((m) => m.role === "assistant");
    expect(assistant.content[0]).toEqual({ type: "reasoning", text: "I should call list_dir." });
  });

  it("adds the block to EVERY tool-call turn in a multi-round history", () => {
    const out = openaiToCommandCodeRequest(DEEPSEEK, {
      messages: [
        { role: "user", content: "List files." },
        toolCallTurn(),
        toolResult,
        toolCallTurn(),
        { role: "tool", tool_call_id: "call_1", name: "list_dir", content: "a.txt" },
      ],
    }, true);

    const assistants = out.params.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    for (const a of assistants) expect(a.content[0].type).toBe("reasoning");
  });

  it("echoes the block for non-DeepSeek models too (upstream v0.5.81 widened this)", () => {
    // This test used to pin the opposite — the fork limited the echo to DeepSeek, so a
    // Kimi turn got no reasoning block. Upstream 092c84ea now emits it for every model
    // (with `thought`/`reasoning` as extra aliases), which is the behaviour adopted
    // here: the block only echoes reasoning the CLIENT already sent, and a turn with
    // tool calls always gets at least the " " placeholder.
    const out = openaiToCommandCodeRequest(KIMI, { messages: messagesFor() }, true);
    const types = out.params.messages.find((m) => m.role === "assistant").content.map((b) => b.type);

    expect(types).toContain("reasoning");
    expect(types).toContain("tool-call");
  });

  it("emits exactly ONE reasoning block per turn — no duplicate from the old fork arm", () => {
    // The merge left upstream's arm (every model) directly above the fork's
    // deepseek-only arm, which had become a strict subset: a DeepSeek turn produced
    // two identical blocks. Pin the count, not just the presence.
    const out = openaiToCommandCodeRequest(DEEPSEEK, { messages: messagesFor() }, true);
    const assistant = out.params.messages.find((m) => m.role === "assistant");
    const reasoningBlocks = assistant.content.filter((b) => b.type === "reasoning");
    expect(reasoningBlocks).toHaveLength(1);
  });

  it("leaves assistant turns without tool calls alone", () => {
    const out = openaiToCommandCodeRequest(DEEPSEEK, {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "bye" },
      ],
    }, true);

    const assistant = out.params.messages.find((m) => m.role === "assistant");
    expect(assistant.content).toEqual([{ type: "text", text: "Hello!" }]);
  });
});
