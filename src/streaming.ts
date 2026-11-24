/**
 * Server-sent-event plumbing for the metered proxy.
 *
 * Why a stream transformer at all: the app's managed route is authenticated by a virtual key, so
 * every proxied answer must carry the quota headers — but the *usage* that matters arrives at the
 * very end of the stream, long after the response head was sent. The compromise is explicit and
 * documented: headers describe the state **before** this request (what the app needs to mirror
 * the month), while this request's tokens are added to KV as its last chunk goes past.
 *
 * The transform never buffers the body: each chunk is inspected and forwarded in the same turn, so
 * time-to-first-token is unchanged and a long answer is not held in memory.
 */

import { MANAGED_MODEL_ALIAS } from "./constants";
import type { DetailedUsage } from "./cost";
import { extractDetailedUsage } from "./cost";
import { normalizeTokenCount } from "./quota";

/** Token counts reported by the provider for one request. */
export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
}

/** Accumulates the token counts seen while a stream (or a whole body) goes past. */
export interface UsageCollector {
  /** Adds one parsed `usage` object, ignoring nulls and garbage. */
  add(usage: unknown): void;
  /** Prompt + completion tokens seen so far, non-negative integers. */
  total(): number;
  /** The individual counts, for logging and for the upstream-usage path. */
  counts(): UsageTotals;
  /** Detailed cache-hit / cache-miss / completion counts for µUSD cost calculation. */
  detailedCounts(): DetailedUsage;
  /** True once at least one usage object with a non-zero total was seen. */
  hasUsage(): boolean;
}

export function createUsageCollector(): UsageCollector {
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheHitTokens = 0;
  let cacheMissTokens = 0;
  let seen = false;
  return {
    add(usage: unknown): void {
      if (usage === null || typeof usage !== "object") return;
      const record = usage as Record<string, unknown>;
      const prompt = normalizeTokenCount(record["prompt_tokens"]);
      const completion = normalizeTokenCount(record["completion_tokens"]);
      if (prompt === 0 && completion === 0) return;
      const detailed = extractDetailedUsage(record);
      // DeepSeek sends `usage: null` on every chunk but the last, and some OpenAI-compatible
      // servers repeat the running total on every chunk. Taking the larger of the two counts
      // rather than summing avoids counting a repeated total twice.
      promptTokens = Math.max(promptTokens, prompt);
      completionTokens = Math.max(completionTokens, completion);
      cacheHitTokens = Math.max(cacheHitTokens, detailed.cacheHitTokens);
      cacheMissTokens = Math.max(cacheMissTokens, detailed.cacheMissTokens);
      seen = true;
    },
    total(): number {
      return promptTokens + completionTokens;
    },
    counts(): UsageTotals {
      return { promptTokens, completionTokens };
    },
    detailedCounts(): DetailedUsage {
      const hit = Math.min(promptTokens, cacheHitTokens);
      const miss = cacheMissTokens > 0 ? cacheMissTokens : Math.max(0, promptTokens - hit);
      return {
        promptTokens,
        completionTokens,
        cacheHitTokens: hit,
        cacheMissTokens: miss,
      };
    },
    hasUsage(): boolean {
      return seen;
    },
  };
}

/** Usage carried by a non-streaming completion body. */
export function usageFromJsonBody(body: unknown): UsageTotals {
  const collector = createUsageCollector();
  if (body !== null && typeof body === "object") {
    collector.add((body as Record<string, unknown>)["usage"]);
  }
  return collector.counts();
}

/** Detailed usage (including prompt cache hit/miss breakdown) from a non-streaming completion body. */
export function detailedUsageFromJsonBody(body: unknown): DetailedUsage {
  const collector = createUsageCollector();
  if (body !== null && typeof body === "object") {
    collector.add((body as Record<string, unknown>)["usage"]);
  }
  return collector.detailedCounts();
}

/**
 * Pulls token usage out of an SSE chunk's data payload.
 *
 * Tolerates every shape DeepSeek's documentation allows: `usage` null on the non-final chunks,
 * usage riding on the last content chunk (their docs are explicit that no separate usage-only
 * chunk is emitted — https://api-docs.deepseek.com/api/create-chat-completion), and providers
 * that emit a final usage-only chunk with an empty `choices` array.
 */
export function usageFromSsePayload(payload: string): UsageTotals | null {
  const raw = rawUsageObjectFromSsePayload(payload);
  if (raw === null) return null;
  const collector = createUsageCollector();
  collector.add(raw);
  return collector.hasUsage() ? collector.counts() : null;
}

function rawUsageObjectFromSsePayload(payload: string): Record<string, unknown> | null {
  const trimmed = payload.trim();
  if (trimmed === "" || trimmed === "[DONE]") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // A provider error line, a keep-alive comment, or a truncated frame: not our business.
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const usage = (parsed as Record<string, unknown>)["usage"];
  if (usage === null || typeof usage !== "object") return null;
  return usage as Record<string, unknown>;
}

/**
 * Splits complete lines off a buffer, returning them and the remaining partial line.
 *
 * A complete line is returned **without** its terminator: the caller forwards lines with `\n`
 * separators, and a carried-over `\r` would survive into that output. A trailing lone `\r` — which
 * may be the first half of a `\r\n` that has not arrived yet — stays in the remainder rather than
 * being treated as a complete break.
 */
export function takeCompleteLines(buffer: string): { lines: string[]; rest: string } {
  const lastBreak = Math.max(buffer.lastIndexOf("\n"), buffer.lastIndexOf("\r"));
  if (lastBreak < 0) return { lines: [], rest: buffer };
  const head = buffer.slice(0, lastBreak);
  const rest = buffer.slice(lastBreak + 1);
  // A break at the very end of the buffer is a terminator with no following line yet: the head is
  // everything before it.
  if (head === "") return { lines: [], rest: buffer };
  const lines = head.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  return { lines, rest };
}

/** The `data:` value of one SSE line, or null when the line is not a data line. */
export function dataLineValue(line: string): string | null {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!normalized.startsWith("data:")) return null;
  const value = normalized.slice("data:".length);
  return value.startsWith(" ") ? value.slice(1) : value;
}

/**
 * A `TransformStream<Uint8Array, Uint8Array>` that watches the SSE bytes going past.
 *
 * The bytes themselves are never rewritten: the app's decoder
 * (`network/streaming/SseDecoder.kt`) is fed exactly what DeepSeek produced. Only two things are
 * read out of the passing text — token usage, and whether the model field needs an alias rewrite
 * (see `createModelAliasRewriter`).
 */
export class SseInspector {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private readonly collector = createUsageCollector();
  private totalBytes = 0;

  /** Prompt + completion tokens seen so far. */
  totalTokens(): number {
    return this.collector.total();
  }

  counts(): UsageTotals {
    return this.collector.counts();
  }

  detailedCounts(): DetailedUsage {
    return this.collector.detailedCounts();
  }

  hasUsage(): boolean {
    return this.collector.hasUsage();
  }

  /** Total SSE payload bytes inspected so far, used for fallback estimation on truncated streams. */
  bytesSeen(): number {
    return this.totalBytes;
  }

  /** Feeds one chunk and returns the usage it contained, if any. */
  inspect(chunk: Uint8Array): UsageTotals | null {
    this.totalBytes += chunk.byteLength;
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const { lines, rest } = takeCompleteLines(this.buffer);
    this.buffer = rest;
    let found: UsageTotals | null = null;
    for (const line of lines) {
      const value = dataLineValue(line);
      if (value === null) continue;
      const rawUsage = rawUsageObjectFromSsePayload(value);
      if (rawUsage !== null) {
        this.collector.add(rawUsage);
        if (this.collector.hasUsage()) {
          found = this.collector.counts();
        }
      }
    }
    return found;
  }

  /**
   * Flushes any trailing frame that arrived without a terminating newline.
   *
   * Called when the upstream stream closes, mirroring `SseDecoder.flush()` on the client.
   */
  flush(): UsageTotals | null {
    this.buffer += this.decoder.decode();
    const remaining = this.buffer.trim();
    this.buffer = "";
    if (remaining === "") return null;
    let found: UsageTotals | null = null;
    for (const line of remaining.split(/\r?\n/)) {
      const value = dataLineValue(line);
      if (value === null) continue;
      const rawUsage = rawUsageObjectFromSsePayload(value);
      if (rawUsage !== null) {
        this.collector.add(rawUsage);
        if (this.collector.hasUsage()) {
          found = this.collector.counts();
        }
      }
    }
    return found;
  }
}

/**
 * The one error frame the client is ever allowed to see from a streamed upstream answer.
 *
 * Some providers report an error *inside* an HTTP 200 event stream (a `data: {"error":…}` frame
 * after the head has gone out). That frame is an upstream error just as much as a 4xx is, so it is
 * replaced before the client sees it: the provider's wording, docs URLs and request ids otherwise
 * reach the app's error reader verbatim. Shape is the OpenAI error envelope the app already parses.
 */
export const GENERIC_SSE_ERROR_FRAME = JSON.stringify({
  error: {
    message: "The managed model service returned an error. Please try again.",
    type: "gestu_upstream_error",
    code: "upstream_error",
    param: null,
  },
});

/** Returns the sanitized data payload when `payload` is an upstream error frame, else `null`. */
export function sanitizedSseErrorPayload(payload: string): string | null {
  const trimmed = payload.trim();
  if (trimmed === "" || trimmed === "[DONE]") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return "error" in (parsed as Record<string, unknown>) ? GENERIC_SSE_ERROR_FRAME : null;
}

/**
 * Rewrites the `model` field of each SSE data frame from the upstream model name back to the
 * app-facing id, and replaces any upstream error frame with a generic Gestu one.
 *
 * The app selects the model by id (`gestu-pro-flash`, `gemini-3.5-flash-lite`) and the upstream is
 * called with its own id; the OpenAI dialect echoes the model in every chunk. Routing chunks
 * textually rather than re-serialising them keeps the payload byte-identical everywhere else —
 * except an error frame, which must never be forwarded because it is the one place a provider name,
 * host or credential fragment would reach a customer.
 */
export function createModelAliasRewriter(upstreamModel: string, alias: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const needle = `"model":"${upstreamModel}"`;
  const replacement = `"model":"${alias}"`;

  const sanitizeLine = (line: string): string => {
    const value = dataLineValue(line);
    if (value !== null) {
      const safePayload = sanitizedSseErrorPayload(value);
      if (safePayload !== null) {
        return `data: ${safePayload}`;
      }
    }
    return line.includes(needle) ? line.split(needle).join(replacement) : line;
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const { lines, rest } = takeCompleteLines(buffer);
      buffer = rest;
      if (lines.length === 0) return;
      controller.enqueue(encoder.encode(lines.map(sanitizeLine).join("\n") + "\n"));
    },
    flush(controller) {
      const tail = buffer + decoder.decode();
      buffer = "";
      if (tail === "") return;
      controller.enqueue(encoder.encode(sanitizeLine(tail)));
    },
  });
}

/** The alias the app expects in a response body, or the upstream id when it is already the alias. */
export function responseModelName(requestedModel: string): string {
  return requestedModel === MANAGED_MODEL_ALIAS ? MANAGED_MODEL_ALIAS : requestedModel;
}

/**
 * Rewrites the `model` field of a whole JSON completion body, for the non-streaming path.
 *
 * Returns the body untouched when it does not parse or does not carry the field — a metering
 * proxy must never be the reason a valid answer turns into an error.
 */
export function rewriteModelInJsonBody(body: string, upstreamModel: string, alias: string): string {
  if (!body.includes(`"${upstreamModel}"`)) return body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (record["model"] === upstreamModel) {
        record["model"] = alias;
        return JSON.stringify(record);
      }
    }
  } catch {
    return body;
  }
  return body;
}
