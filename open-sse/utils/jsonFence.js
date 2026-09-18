/**
 * Providers that receive Structured Output as a prompt instruction rather than a
 * native schema (Claude-backed ones especially) tend to answer with the JSON
 * wrapped in a ```json fence. Clients that JSON.parse the content — anything
 * using schema-parsed calls — choke on it.
 *
 * Instructing those providers not to fence is unreliable in practice, so the
 * fence is stripped on the way out instead. Guarded two ways: only when the
 * request actually asked for JSON output, and only when the WHOLE content is a
 * single fenced block (an ordinary answer that merely contains a code block is
 * left untouched).
 */

// Whole content is one fenced block: ```json\n{...}\n```
const FENCED_JSON = /^\s*```(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n?\s*```\s*$/;

/**
 * Did the caller ask for JSON output? Reads the Chat Completions spelling AND
 * the Responses spelling, since either can arrive depending on the hop.
 */
export function wantsJsonOutput(body) {
  const type = body?.response_format?.type;
  if (type === "json_schema" || type === "json_object") return true;
  const formatType = body?.text?.format?.type;
  return formatType === "json_schema" || formatType === "json_object";
}

/**
 * Strip the fence when the entire content is one fenced block.
 * Anything else (prose, prose containing a code block, null, non-string) is
 * returned unchanged.
 */
export function stripJsonFence(content) {
  if (typeof content !== "string") return content;
  const match = content.match(FENCED_JSON);
  // The lazy capture can backtrack across a SECOND fenced block (two adjacent
  // blocks would otherwise be unwrapped into one). A single fenced block never
  // contains a fence of its own, so reject that case explicitly.
  if (!match || match[1].includes("```")) return content;
  return match[1].trim();
}

/**
 * Unfence the assistant content of an OpenAI-shaped response, in place.
 *
 * Handles BOTH output shapes, because the same request can land in either one:
 *   - Chat Completions: `choices[].message.content`
 *   - Responses API:    `output[].content[].text` (type `output_text`)
 * A Chat client talking to a Chat-backed provider gets the first; a Responses
 * client (`/v1/responses`) whose provider only speaks Chat gets the second,
 * produced by `openAICompletionToResponses()`. Handling only `choices` left a
 * silent hole in the Responses shape (verified: the fence survived).
 *
 * ponytail: non-streaming only — a streaming client would need the fence
 * stripped across chunk boundaries, so that case is deliberately left alone.
 * Returns the same object it was given.
 */
export function unfenceJsonChoices(body, response) {
  if (!wantsJsonOutput(body)) return response;

  if (Array.isArray(response?.choices)) {
    for (const choice of response.choices) {
      const message = choice?.message;
      if (message) message.content = stripJsonFence(message.content);
    }
  }

  if (Array.isArray(response?.output)) {
    for (const item of response.output) {
      if (!Array.isArray(item?.content)) continue;
      for (const part of item.content) {
        if (part?.type === "output_text") part.text = stripJsonFence(part.text);
      }
    }
  }

  return response;
}
