import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel, PROVIDER_CAPABILITIES, MODEL_CAPABILITIES } from "open-sse/providers/capabilities.js";
import { resolveProviderAlias } from "open-sse/services/model.js";

// DeepSeek V4.1 Flash reads images — verified live against Command Code's
// OpenAI-compatible endpoint. Vision is a property of the MODEL, so the canonical
// table says true, and since upstream v0.5.81 (13b468b8) the Command Code provider
// arm says true as well: that commit maps image_url / Claude image blocks onto the
// native {type:"image", …} generate block, inlines http(s) images, and scopes vision
// by a text-only denylist instead of a blanket per-transport override.
//
// This file previously pinned the opposite (the fork forced vision:false on the
// commandcode arm because /alpha/generate answered the wrong colour). The measured
// decision on 2026-09-18 was to follow upstream. If a live image test shows the CLI
// still mangles colours, restore the fork entry AND these expectations together.
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

  it("serves vision:true on the Command Code CLI transport (cmc/) too", () => {
    const caps = getCapabilitiesForModel("commandcode", MODEL);
    expect(caps.vision).toBe(true);
  });

  it("resolves the cmc alias to the commandcode provider id before capability lookup", () => {
    expect(resolveProviderAlias("cmc")).toBe("commandcode");
    expect(getCapabilitiesForModel(resolveProviderAlias("cmc"), MODEL).vision).toBe(true);
  });

  it("does not carry a blanket commandcode override any more", () => {
    // The removed fork entry returned early and masked upstream's transport fix.
    expect(PROVIDER_CAPABILITIES.commandcode?.["deepseek-v4.1-flash"]).toBeUndefined();
    expect(PROVIDER_CAPABILITIES.commandcode?.["deepseek/deepseek-v4.1-flash"]).toBeUndefined();
  });

  it("keeps the text-only denylist intact, so superseeded ids stay text-only", () => {
    expect(getCapabilitiesForModel("commandcode", "deepseek/deepseek-v4-flash").vision).toBe(false);
    expect(getCapabilitiesForModel("commandcode", "deepseek/deepseek-v4-pro").reasoning).toBe(true);
  });

  it("keeps the model's other capabilities intact on both routes", () => {
    for (const provider of ["commandcode", OPENAI_COMPAT_NODE]) {
      const caps = getCapabilitiesForModel(provider, MODEL);
      expect(caps.reasoning).toBe(true);
      expect(caps.contextWindow).toBe(1000000);
      expect(caps.maxOutput).toBe(384000);
    }
  });
});
