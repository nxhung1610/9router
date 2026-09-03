import { describe, expect, it } from "vitest";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";

describe("OpenCodeGo muse-spark reasoning", () => {
  it("converts reasoning_effort to Responses reasoning shape", () => {
    const ex = new OpenCodeGoExecutor();
    const body = { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high", max_tokens: 256 };
    const out = ex.transformRequest("muse-spark-1.3-contributor", { ...body }, true, {});
    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.thinking).toBeUndefined();
    expect(out.max_output_tokens).toBe(256);
    expect(out.max_tokens).toBeUndefined();
  });

  it("drops Chat-only thinking field (upstream 400s on it too)", () => {
    const ex = new OpenCodeGoExecutor();
    const body = { messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled" }, reasoning: { effort: "high" } };
    const out = ex.transformRequest("muse-spark-1.2-contributor", { ...body }, true, {});
    expect(out.thinking).toBeUndefined();
    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("clamps max/ultra to xhigh when unsupported", () => {
    const ex = new OpenCodeGoExecutor();
    const out = ex.transformRequest("muse-spark-1.3-contributor", { messages: [], reasoning_effort: "max" }, true, {});
    expect(["xhigh", "max"]).toContain(out.reasoning.effort);
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("leaves non-muse models untouched", () => {
    const ex = new OpenCodeGoExecutor();
    const body = { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high", max_tokens: 64 };
    const out = ex.transformRequest("deepseek-v4-flash", { ...body }, true, {});
    expect(out.reasoning_effort).toBe("high");
    expect(out.max_tokens).toBe(64);
  });
});
