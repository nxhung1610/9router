import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel, PROVIDER_CAPABILITIES, MODEL_CAPABILITIES } from "open-sse/providers/capabilities.js";
import { resolveProviderAlias } from "open-sse/services/model.js";

// DeepSeek V4.1 Flash reads images — verified live against Command Code's
// OpenAI-compatible endpoint. Vision is a property of the MODEL, so the canonical
// table must say true; only the CLI transport (/alpha/generate) narrows it, because
// that route mangles images. These tests pin both halves so neither one can
// silently take the other's place.
const MODEL = "deepseek/deepseek-v4.1-flash";

// The command/ route resolves to the user's openai-compatible node id (a UUID,
// assigned at runtime) — any node id exercises the same lookup path.
const OPENAI_COMPAT_NODE = "openai-compatible-chat-1e45ac82-e638-43f9-9c62-2f018f01af09";

describe("DeepSeek V4.1 Flash vision capability", () => {
  it("keeps vision:true on the model, where capability belongs", () => {
    expect(MODEL_CAPABILITIES["deepseek-v4.1-flash"].vision).toBe(true);
  });

  it("serves vision:true through the OpenAI-compatible route (command/)", () => {
    const caps = getCapabilitiesForModel(OPENAI_COMPAT_NODE, MODEL);
    expect(caps.vision).toBe(true);
  });

  it("narrows vision on the Command Code CLI transport (cmc/), which cannot carry an image", () => {
    const caps = getCapabilitiesForModel("commandcode", MODEL);
    expect(caps.vision).toBe(false);
  });

  it("resolves the cmc alias to the commandcode provider id before capability lookup", () => {
    // The alias is resolved upstream (`cmc` -> `commandcode`), and only the id is
    // passed to getCapabilitiesForModel. Pin that, so a future change that passes
    // the raw alias cannot silently fall through to the model table and regain
    // vision on the transport that mangles images.
    expect(resolveProviderAlias("cmc")).toBe("commandcode");
    expect(getCapabilitiesForModel(resolveProviderAlias("cmc"), MODEL).vision).toBe(false);
  });

  it("does not change the capability of its sibling models", () => {
    // The provider override is keyed per model — a blanket provider entry would
    // have disabled vision on every Command Code model.
    expect(getCapabilitiesForModel("commandcode", "deepseek/deepseek-v4-pro").reasoning).toBe(true);
    expect(PROVIDER_CAPABILITIES.commandcode?.["deepseek/deepseek-v4-pro"]).toBeUndefined();
  });

  it("keeps the model's other capabilities intact on both routes", () => {
    for (const provider of ["commandcode", OPENAI_COMPAT_NODE]) {
      const caps = getCapabilitiesForModel(provider, MODEL);
      expect(caps.reasoning).toBe(true);
      expect(caps.thinkingFormat).toBe("deepseek");
      expect(caps.contextWindow).toBe(1000000);
      expect(caps.maxOutput).toBe(384000);
    }
  });
});
