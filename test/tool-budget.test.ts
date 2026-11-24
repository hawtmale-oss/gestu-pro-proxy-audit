import { describe, expect, it } from "vitest";
import {
  enforceToolCallsPerTurn,
  FREE_TOOL_CALLS_PER_TURN,
  isToolContinuation,
  PRO_TOOL_CALLS_PER_TURN,
  toolCallsSinceLastUserMessage,
} from "../src/tool-budget";

const call = (id: string) => ({ id, type: "function", function: { name: "t", arguments: "{}" } });

/** A turn with `n` assistant tool calls after the user's message, each answered by a tool result. */
function turnWith(n: number): unknown[] {
  const messages: unknown[] = [
    { role: "user", content: "earlier question" },
    { role: "assistant", tool_calls: [call("old-1"), call("old-2")] },
    { role: "tool", tool_call_id: "old-1", content: "x" },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: "new question" },
  ];
  for (let i = 0; i < n; i += 1) {
    messages.push({ role: "assistant", tool_calls: [call(`c${i}`)] });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: "ok" });
  }
  return messages;
}

describe("tool-budget", () => {
  it("counts only tool calls since the most recent user message", () => {
    expect(toolCallsSinceLastUserMessage(turnWith(0))).toBe(0);
    expect(toolCallsSinceLastUserMessage(turnWith(4))).toBe(4);
    expect(toolCallsSinceLastUserMessage("not an array")).toBe(0);
  });

  it("counts parallel tool calls in one assistant message individually", () => {
    const messages = [
      { role: "user", content: "go" },
      { role: "assistant", tool_calls: [call("a"), call("b"), call("c")] },
    ];
    expect(toolCallsSinceLastUserMessage(messages)).toBe(3);
  });

  it("recognises a tool continuation by its last message", () => {
    expect(isToolContinuation(turnWith(1))).toBe(true);
    expect(isToolContinuation([{ role: "user", content: "hi" }])).toBe(false);
  });

  it("switches tools off at the Free per-turn cap and leaves them on below it", () => {
    const below = { tools: [{ type: "function" }], messages: turnWith(FREE_TOOL_CALLS_PER_TURN - 1) };
    expect(enforceToolCallsPerTurn(below, "free")).toBe(false);
    expect(below).not.toHaveProperty("tool_choice");

    const at = { tools: [{ type: "function" }], messages: turnWith(FREE_TOOL_CALLS_PER_TURN) };
    expect(enforceToolCallsPerTurn(at, "free")).toBe(true);
    expect(at).toHaveProperty("tool_choice", "none");
  });

  it("gives Pro its larger per-turn budget", () => {
    const body = { tools: [{ type: "function" }], messages: turnWith(FREE_TOOL_CALLS_PER_TURN) };
    expect(enforceToolCallsPerTurn(body, "pro")).toBe(false);
    const atPro = { tools: [{ type: "function" }], messages: turnWith(PRO_TOOL_CALLS_PER_TURN) };
    expect(enforceToolCallsPerTurn(atPro, "pro")).toBe(true);
  });

  it("leaves a request without tools untouched", () => {
    const body = { messages: turnWith(99) };
    expect(enforceToolCallsPerTurn(body, "free")).toBe(false);
    expect(body).not.toHaveProperty("tool_choice");
  });
});
