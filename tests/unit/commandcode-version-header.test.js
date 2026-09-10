/**
 * Guard: the version header sent to Command Code must track a real published CLI version.
 *
 * Context: 9router shipped `x-command-code-version: 0.25.7` for months while the published CLI
 * reached 1.53.0. Upstream may route/throttle on this header, so a stale value is a silent
 * behavioural change. This test pins the value to the registry AND asserts it looks like a
 * released semver rather than an ancient build.
 */

import { describe, it, expect } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";

describe("commandcode registry — CLI version header", () => {
  // PROVIDERS[id] IS the transport object (buildTransport flattens it), so headers
  // live at the top level — not under .transport.
  const headers = PROVIDERS.commandcode.headers;

  it("sends x-command-code-version", () => {
    expect(headers["x-command-code-version"]).toBeDefined();
    expect(typeof headers["x-command-code-version"]).toBe("string");
  });

  it("is a well-formed semver", () => {
    expect(headers["x-command-code-version"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is not the stale 0.x build line", () => {
    const [major] = headers["x-command-code-version"].split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(1);
  });

  it("keeps the CLI environment header so upstream sees a CLI client", () => {
    expect(headers["x-cli-environment"]).toBe("cli");
  });

  it("still targets the alpha/generate endpoint and forces streaming", () => {
    expect(PROVIDERS.commandcode.baseUrl).toBe("https://api.commandcode.ai/alpha/generate");
    expect(PROVIDERS.commandcode.forceStream).toBe(true);
  });
});
