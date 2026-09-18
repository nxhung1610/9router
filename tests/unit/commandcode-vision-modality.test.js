import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { stripUnsupportedModalities } from "open-sse/translator/concerns/modality.js";
import { FORMATS } from "open-sse/translator/formats.js";

// The capability table only matters if it changes what reaches the executor.
// chatCore calls getCapabilitiesForModel() then stripUnsupportedModalities() with
// the result, which DELETES image blocks — so assert on the actual body, not just
// on the flag. A vision:true that still arrives stripped would be worthless.
const MODEL = "deepseek/deepseek-v4.1-flash";
const OPENAI_COMPAT_NODE = "openai-compatible-chat-1e45ac82-e638-43f9-9c62-2f018f01af09";

const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const bodyWithImage = () => ({
  model: MODEL,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "what colour is this image?" },
        { type: "image_url", image_url: { url: IMAGE } },
      ],
    },
  ],
});

const imagesLeft = (body) =>
  body.messages[0].content.filter((b) => b.type === "image_url" || b.type === "image");

describe("image survives the strip pass on the route that can carry it", () => {
  it("keeps the image on the OpenAI-compatible route (command/)", () => {
    const caps = getCapabilitiesForModel(OPENAI_COMPAT_NODE, MODEL);
    const body = bodyWithImage();
    stripUnsupportedModalities(body, FORMATS.OPENAI, caps);
    expect(imagesLeft(body)).toHaveLength(1);
  });

  it("keeps the image on the Command Code CLI transport (cmc/) since v0.5.81", () => {
    // Upstream 13b468b8 gave the CLI transport native image blocks plus base64
    // inlining, so the strip pass no longer removes the image here. The fork used to
    // strip it because /alpha/generate returned the wrong colour; that override is
    // gone. A live colour test decides whether it comes back.
    const caps = getCapabilitiesForModel("commandcode", MODEL);
    const body = bodyWithImage();
    stripUnsupportedModalities(body, FORMATS.OPENAI, caps);
    expect(imagesLeft(body)).toHaveLength(1);
  });

  it("still strips the image for a model on the CLI text-only denylist", () => {
    const caps = getCapabilitiesForModel("commandcode", "deepseek/deepseek-v4-flash");
    const body = bodyWithImage();
    stripUnsupportedModalities(body, FORMATS.OPENAI, caps);
    expect(imagesLeft(body)).toHaveLength(0);
  });

  it("keeps the text of the request in every case", () => {
    for (const [provider, model] of [[OPENAI_COMPAT_NODE, MODEL], ["commandcode", MODEL], ["commandcode", "deepseek/deepseek-v4-flash"]]) {
      const body = bodyWithImage();
      stripUnsupportedModalities(body, FORMATS.OPENAI, getCapabilitiesForModel(provider, model));
      expect(JSON.stringify(body)).toContain("what colour is this image?");
    }
  });
});
