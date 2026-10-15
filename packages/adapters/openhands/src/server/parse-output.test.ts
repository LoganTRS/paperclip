import { describe, it, expect } from "vitest";

import { parseOpenHandsOutput } from "./execute.js";

describe("parseOpenHandsOutput", () => {
  it("parses a clean JSON result", () => {
    const stdout =
      '{"ok":true,"response":"Done.","conversation_id":"123e4567-e89b-12d3-a456-426614174000","usage":{"input_tokens":100,"output_tokens":40},"error":null,"timed_out":false}\n';
    const r = parseOpenHandsOutput(stdout, "");
    expect(r.ok).toBe(true);
    expect(r.response).toBe("Done.");
    expect(r.conversationId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 40 });
    expect(r.errorMessage).toBeNull();
  });

  it("picks the last JSON object when multiple lines exist", () => {
    const stdout =
      '{"ok":false,"response":"","conversation_id":null,"usage":null,"error":"stale"}\n' +
      '{"ok":true,"response":"final","conversation_id":"abc","usage":null,"error":null,"timed_out":false}\n';
    const r = parseOpenHandsOutput(stdout, "");
    expect(r.ok).toBe(true);
    expect(r.response).toBe("final");
  });

  it("falls back to stderr tail when no JSON present", () => {
    const stderr = "line1\nboom: real failure";
    const r = parseOpenHandsOutput("", stderr);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("boom: real failure");
  });

  it("returns a generic error when both stdout and stderr are empty", () => {
    const r = parseOpenHandsOutput("", "");
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBeTruthy();
  });

  it("treats non-JSON stdout as a failure with context", () => {
    const r = parseOpenHandsOutput("just some text, no json", "");
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBeTruthy();
  });
});
