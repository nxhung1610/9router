import { FORMATS } from "../../translator/formats.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";

/**
 * Parse a tool-call arguments field (JSON string or already-parsed object).
 */
export function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Convert an OpenAI Chat Completions body into an Anthropic Message.
 *
 * Shared by the non-streaming path (nonStreamingHandler.js) and the
 * forced-SSE→JSON path (sseToJsonHandler.js) so a Claude client gets the SAME
 * body whichever route the request took. Without this the forced-SSE path
 * returned a `chat.completion` body on HTTP 200, which the Anthropic SDK
 * (Claude Code) rejects with "body is JSON but not a Message".
 *
 * `requestModel` overrides the echoed model — callers on a relay pass the model
 * the CLIENT asked for, so an Anthropic client sees a model id it recognises
 * instead of the upstream one. Omitted → the provider's own body is echoed,
 * which is the historical behaviour of the non-streaming path.
 */
export function openAICompletionToClaudeMessage(responseBody, requestModel = null) {
  if (!responseBody?.choices?.[0]) return responseBody;
  const choice = responseBody.choices[0];
  const message = choice.message || {};
  const content = [];

  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseToolArguments(fn.arguments || toolCall.arguments),
    });
  }
  // Anthropic always returns at least one content block; an empty array reads as
  // a malformed Message to some clients.
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = responseBody.usage || {};
  return {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: "message",
    role: "assistant",
    model: requestModel || responseBody.model || "unknown",
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    },
  };
}
