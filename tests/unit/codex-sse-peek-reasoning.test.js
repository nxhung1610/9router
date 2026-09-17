import { describe, expect, it } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

// Regression guard: the SSE peek must release the stream as soon as REASONING
// deltas arrive. Reasoning is user-visible output — the translator converts
// response.reasoning_summary_text.delta into reasoning_content. If the peek
// does not treat it as output, the whole thinking phase is buffered and the
// client sees TTFT == model reasoning time (measured 22-80s instead of ~3s).

const encoder = new TextEncoder();

function delayedStream(text, delayMs, chunkCount) {
  const whole = encoder.encode(text);
  const size = Math.ceil(whole.length / chunkCount);
  const chunks = [];
  for (let i = 0; i < whole.length; i += size) chunks.push(whole.slice(i, i + size));
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(chunks[i++]);
    },
  });
}

function codexSse(reasoningDeltas) {
  const sse = (event, obj) => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
  const p = [];
  p.push(sse("response.created", { type: "response.created" }));
  p.push(sse("response.output_item.added", {
    type: "response.output_item.added", output_index: 0,
    item: { id: "rs_1", type: "reasoning", summary: [] },
  }));
  for (let i = 0; i < reasoningDeltas; i++) {
    p.push(sse("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta", item_id: "rs_1",
      output_index: 0, summary_index: 0, delta: `step ${i}, `,
    }));
  }
  p.push(sse("response.output_text.delta", {
    type: "response.output_text.delta", output_index: 0, delta: "FINAL ANSWER",
  }));
  p.push(sse("response.completed", { type: "response.completed" }));
  return p.join("");
}

function responseFrom(stream) {
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("Codex SSE peek releases reasoning deltas immediately", () => {
  it("stops peeking on the first reasoning delta", async () => {
    const executor = new CodexExecutor();
    const text = codexSse(40);
    const t0 = Date.now();
    const peek = await executor._peekSseTransientError(
      responseFrom(delayedStream(text, 25, 60))
    );
    const peekMs = Date.now() - t0;

    expect(peek.matched).toBeNull();
    expect(peek.replacementBody).not.toBeNull();
    // Peek must not wait for the whole reasoning phase. 40 deltas at 25ms
    // take >900ms of upstream time; releasing on the first one stays far below.
    expect(peekMs).toBeLessThan(600);
  });

  it("reassembles the stream intact after releasing early", async () => {
    const executor = new CodexExecutor();
    const text = codexSse(40);
    const peek = await executor._peekSseTransientError(
      responseFrom(delayedStream(text, 20, 60))
    );
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  it("still classifies an in-stream capacity error as account fallback", async () => {
    const executor = new CodexExecutor();
    const body = [
      "event: error",
      'data: {"error":{"message":"Selected model is at capacity. Please try a different model."}}',
      "",
    ].join("\n");
    const peek = await executor._peekSseTransientError(responseFrom(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      })
    ));
    expect(peek.accountFallback).toBe(true);
    expect(peek.message).toBe("Selected model is at capacity. Please try a different model.");
  });

  it("still classifies an overloaded error as retry", async () => {
    const executor = new CodexExecutor();
    const body = [
      "event: error",
      'data: {"error":{"message":"server_is_overloaded"}}',
      "",
    ].join("\n");
    const peek = await executor._peekSseTransientError(responseFrom(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      })
    ));
    expect(peek.matched).toBe("server_is_overloaded");
    expect(peek.accountFallback).toBe(false);
  });
});
