import { DefaultExecutor } from "./default.js";
import { PROVIDERS } from "../config/providers.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";

// Strip a trailing thinking suffix "model(level)" so lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

// /zen/go/v1/responses takes thinking as reasoning:{effort,summary} and 400s on
// Chat-only `reasoning_effort` / `thinking` ("unknown parameter"). The shared
// openai→openai-responses translator builds `reasoning` correctly, but
// applyThinking() re-applies the "openai" thinkingFormat afterwards (caps say
// thinkingFormat:"openai" for muse-spark) which stripAll()s `reasoning` and
// re-adds `reasoning_effort`. Convert back here at the executor boundary.
function normalizeMuseSparkReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode-go", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
  delete body.thinking;
}

export class OpenCodeGoExecutor extends DefaultExecutor {
  constructor() {
    // Explicit config like OpenCodeExecutor (not DefaultExecutor fallback):
    // guarantees this.config/noAuth/headers/timeoutMs track the opencode-go
    // registry entry even if PROVIDERS key renames drift.
    super("opencode-go", PROVIDERS["opencode-go"]);
  }

  transformRequest(model, body, stream, credentials) {
    if (isMuseSparkModel(model)) {
      // Responses API names the output cap max_output_tokens.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeMuseSparkReasoning(model, body);
    }
    return super.transformRequest(model, body, stream, credentials);
  }
}
