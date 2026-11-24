/**
 * Server-side tool-call budgets.
 *
 * The app enforces the same numbers, but anyone can call the gateway directly with a device key, so
 * the gateway is the authority. Every tool round is another paid upstream request, which makes the
 * agent loop the main lever on inference cost.
 *
 *  * Per turn: the tool calls the model has made since the user's last message. At the cap the
 *    request still goes through but with `tool_choice: "none"`, so the model has to answer in text
 *    with what it has gathered instead of the turn failing.
 *  * Per minute (Free only): requests that continue a tool loop (last message is a tool result)
 *    are rate-limited separately from ordinary chat.
 */

import { PLAN_FREE, type PlanTier } from "./constants";

/** Tool calls one turn may make on Gestu Free. */
export const FREE_TOOL_CALLS_PER_TURN = 6;
/** Tool calls one turn may make on Gestu Pro. */
export const PRO_TOOL_CALLS_PER_TURN = 60;
/** Tool-continuation requests one Free device may make per minute. */
export const FREE_TOOL_CALLS_PER_MINUTE = 45;

export function toolCallsPerTurnFor(tier: PlanTier): number {
  return tier === PLAN_FREE ? FREE_TOOL_CALLS_PER_TURN : PRO_TOOL_CALLS_PER_TURN;
}

type Message = { role?: unknown; tool_calls?: unknown };

function asMessages(messages: unknown): Message[] {
  return Array.isArray(messages) ? (messages.filter((m) => m !== null && typeof m === "object") as Message[]) : [];
}

/** Tool calls the assistant has issued since the most recent user message. */
export function toolCallsSinceLastUserMessage(messages: unknown): number {
  const list = asMessages(messages);
  let count = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i]!;
    if (message.role === "user") break;
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      count += message.tool_calls.length;
    }
  }
  return count;
}

/** True when this request continues a tool loop (its last message is a tool result). */
export function isToolContinuation(messages: unknown): boolean {
  const list = asMessages(messages);
  const last = list[list.length - 1];
  return last?.role === "tool";
}

/**
 * Applies the per-turn cap to a request body in place. Returns true when tools were switched off.
 */
export function enforceToolCallsPerTurn(body: Record<string, unknown>, tier: PlanTier): boolean {
  if (!Array.isArray(body["tools"]) || (body["tools"] as unknown[]).length === 0) return false;
  if (toolCallsSinceLastUserMessage(body["messages"]) < toolCallsPerTurnFor(tier)) return false;
  body["tool_choice"] = "none";
  return true;
}
