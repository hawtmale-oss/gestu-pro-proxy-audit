import { describe, expect, it } from "vitest";
import {
  createModelAliasRewriter,
  createUsageCollector,
  dataLineValue,
  GENERIC_SSE_ERROR_FRAME,
  rewriteModelInJsonBody,
  sanitizedSseErrorPayload,
  SseInspector,
  takeCompleteLines,
  usageFromJsonBody,
  usageFromSsePayload,
} from "../src/streaming";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("usageFromSsePayload", () => {
  it("reads the totals off the final content chunk, which is where DeepSeek puts them", () => {
    // DeepSeek documents that no separate usage-only chunk is emitted: the statistics ride on the
    // last content chunk (https://api-docs.deepseek.com/api/create-chat-completion).
    const chunk = JSON.stringify({
      id: "1",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 812, completion_tokens: 143, total_tokens: 955 },
    });
    expect(usageFromSsePayload(chunk)).toEqual({ promptTokens: 812, completionTokens: 143 });
  });

  it("ignores the null usage on the non-final chunks", () => {
    const chunk = JSON.stringify({
      choices: [{ delta: { content: "hi" } }],
      usage: null,
    });
    expect(usageFromSsePayload(chunk)).toBeNull();
  });

  it("ignores [DONE], comments and garbage", () => {
    expect(usageFromSsePayload("[DONE]")).toBeNull();
    expect(usageFromSsePayload("")).toBeNull();
    expect(usageFromSsePayload("   ")).toBeNull();
    expect(usageFromSsePayload("{not json")).toBeNull();
    expect(usageFromSsePayload("null")).toBeNull();
    expect(usageFromSsePayload('"a string"')).toBeNull();
    expect(usageFromSsePayload('{"usage":{"prompt_tokens":0,"completion_tokens":0}}')).toBeNull();
  });

  it("does not double-count a usage block repeated on every chunk", () => {
    const collector = createUsageCollector();
    const running = { prompt_tokens: 100, completion_tokens: 10 };
    collector.add(running);
    collector.add(running);
    collector.add({ prompt_tokens: 100, completion_tokens: 42 });
    expect(collector.counts()).toEqual({ promptTokens: 100, completionTokens: 42 });
    expect(collector.total()).toBe(142);
  });

  it("clamps a malformed usage block instead of poisoning the counter", () => {
    const collector = createUsageCollector();
    collector.add({ prompt_tokens: "800", completion_tokens: -3 });
    expect(collector.hasUsage()).toBe(false);
    expect(collector.total()).toBe(0);
  });
});

describe("usageFromJsonBody", () => {
  it("reads usage from a non-streaming completion", () => {
    expect(
      usageFromJsonBody({
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 },
      }),
    ).toEqual({ promptTokens: 40, completionTokens: 2 });
  });

  it("returns zeros for a body without usage", () => {
    expect(usageFromJsonBody({ choices: [] })).toEqual({ promptTokens: 0, completionTokens: 0 });
    expect(usageFromJsonBody(null)).toEqual({ promptTokens: 0, completionTokens: 0 });
    expect(usageFromJsonBody("nope")).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});

describe("takeCompleteLines / dataLineValue", () => {
  it("holds back a partial trailing line", () => {
    expect(takeCompleteLines("data: a\ndata: b\ndata: par")).toEqual({
      lines: ["data: a", "data: b"],
      rest: "data: par",
    });
  });

  it("handles CRLF, LF and a lone CR framing", () => {
    expect(takeCompleteLines("data: a\r\ndata: b\r\n")).toEqual({ lines: ["data: a", "data: b"], rest: "" });
    expect(takeCompleteLines("data: a\n")).toEqual({ lines: ["data: a"], rest: "" });
  });

  it("strips exactly one leading space after the colon", () => {
    expect(dataLineValue("data: {}")).toBe("{}");
    expect(dataLineValue("data:{}")).toBe("{}");
    expect(dataLineValue("data:  two")).toBe(" two");
    expect(dataLineValue("event: ping")).toBeNull();
    expect(dataLineValue(": keep-alive")).toBeNull();
  });
});

describe("SseInspector", () => {
  it("accumulates usage across chunk boundaries", () => {
    const inspector = new SseInspector();
    inspector.inspect(encode("data: {\"choices\":[{\"delta\":{\"content\":\"he"));
    inspector.inspect(encode("llo\"}}],\"usage\":null}\n\n"));
    const total = inspector.inspect(
      encode(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\n' +
          "data: [DONE]\n\n",
      ),
    );
    expect(total).toEqual({ promptTokens: 10, completionTokens: 4 });
    expect(inspector.counts()).toEqual({ promptTokens: 10, completionTokens: 4 });
    expect(inspector.hasUsage()).toBe(true);
  });

  it("flushes a final frame that arrived without a blank line", () => {
    const inspector = new SseInspector();
    inspector.inspect(
      encode('data: {"usage":{"prompt_tokens":7,"completion_tokens":1}}'),
    );
    expect(inspector.totalTokens()).toBe(0);
    expect(inspector.flush()).toEqual({ promptTokens: 7, completionTokens: 1 });
    expect(inspector.totalTokens()).toBe(8);
  });

  it("reports no usage for a stream that never carried any", () => {
    const inspector = new SseInspector();
    inspector.inspect(encode("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n"));
    expect(inspector.flush()).toBeNull();
    expect(inspector.hasUsage()).toBe(false);
  });
});

describe("createModelAliasRewriter", () => {
  /**
   * Pushes chunks through the transform while draining it.
   *
   * The read has to run concurrently with the writes: a `TransformStream` applies backpressure, so
   * writing everything first and reading afterwards deadlocks (which is also why the proxy always
   * pipes the transform into a `tee()` rather than buffering).
   */
  async function run(stream: TransformStream<Uint8Array, Uint8Array>, chunks: string[]): Promise<string> {
    const reader = stream.readable.getReader();
    const drain = (async (): Promise<string> => {
      const decoder = new TextDecoder();
      let out = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
      return out + decoder.decode();
    })();

    const writer = stream.writable.getWriter();
    for (const chunk of chunks) await writer.write(encode(chunk));
    await writer.close();
    return drain;
  }

  it("renames the upstream model back to the app's alias", async () => {
    const rewriter = createModelAliasRewriter("deepseek-flash", "gestu-pro-flash");
    const output = await run(rewriter, [
      'data: {"id":"1","model":"deepseek-flash","choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(output).toContain('"model":"gestu-pro-flash"');
    expect(output).not.toContain('"model":"deepseek-flash"');
    expect(output).toContain("data: [DONE]");
  });

  it("leaves everything else byte-identical, including content that names the model", async () => {
    const rewriter = createModelAliasRewriter("deepseek-flash", "gestu-pro-flash");
    const line = 'data: {"choices":[{"delta":{"content":"deepseek-flash is the model"}}]}\n\n';
    expect(await run(rewriter, [line])).toBe(line);
  });

  it("reassembles a frame split across chunks and restores the upstream newline", async () => {
    const rewriter = createModelAliasRewriter("deepseek-flash", "gestu-pro-flash");
    const output = await run(rewriter, ['data: {"model":"deepseek-', 'flash","choices":[]}\n\n']);
    // The rewriter emits one `\n` per line it forwarded, so an LF-framed frame stays LF-framed.
    expect(output).toBe('data: {"model":"gestu-pro-flash","choices":[]}\n\n');
  });

  it("flushes a trailing frame with no newline", async () => {
    const rewriter = createModelAliasRewriter("deepseek-flash", "gestu-pro-flash");
    const output = await run(rewriter, ['data: {"model":"deepseek-flash"}']);
    expect(output).toBe('data: {"model":"gestu-pro-flash"}');
  });
});

describe("rewriteModelInJsonBody", () => {
  it("renames the model in a non-streaming body", () => {
    const body = JSON.stringify({ id: "1", model: "deepseek-flash", choices: [] });
    expect(JSON.parse(rewriteModelInJsonBody(body, "deepseek-flash", "gestu-pro-flash"))).toMatchObject({
      model: "gestu-pro-flash",
    });
  });

  it("returns the body untouched when there is nothing to rewrite", () => {
    const body = '{"error":{"message":"bad"}}';
    expect(rewriteModelInJsonBody(body, "deepseek-flash", "gestu-pro-flash")).toBe(body);
  });

  it("never turns a valid body into an error", () => {
    const notJson = "deepseek-flash";
    expect(rewriteModelInJsonBody(notJson, "deepseek-flash", "gestu-pro-flash")).toBe(notJson);
    const arrayBody = '["deepseek-flash"]';
    expect(rewriteModelInJsonBody(arrayBody, "deepseek-flash", "gestu-pro-flash")).toBe(arrayBody);
  });
});

describe("sanitizedSseErrorPayload", () => {
  it("replaces an upstream error frame with the generic Gestu error", () => {
    const payload = JSON.stringify({
      error: { message: "deepseek overloaded", url: "https://api.deepseek.com" },
    });
    const sanitized = sanitizedSseErrorPayload(payload);
    expect(sanitized).toBe(GENERIC_SSE_ERROR_FRAME);
    const haystack = String(sanitized).toLowerCase();
    expect(haystack).not.toContain("deepseek");
    expect(haystack).not.toContain("gemini");
  });

  it("leaves normal content frames and the DONE sentinel alone", () => {
    expect(sanitizedSseErrorPayload("[DONE]")).toBeNull();
    expect(sanitizedSseErrorPayload("")).toBeNull();
    expect(sanitizedSseErrorPayload("not json")).toBeNull();
    expect(
      sanitizedSseErrorPayload(JSON.stringify({ choices: [{ delta: { content: "hi" } }] })),
    ).toBeNull();
  });

  it("sanitizes error frames while rewriting the model id in the same stream", async () => {
    const rewriter = createModelAliasRewriter("deepseek-flash", "gestu-pro-flash");
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encode(
            'data: {"model":"deepseek-flash","choices":[{"delta":{"content":"hi"}}]}\n\n' +
              'data: {"error":{"message":"deepseek-flash overloaded at https://api.deepseek.com"}}\n\n' +
              "data: [DONE]\n\n",
          ),
        );
        controller.close();
      },
    });
    const text = await new Response(input.pipeThrough(rewriter)).text();
    expect(text).toContain('"model":"gestu-pro-flash"');
    expect(text).toContain("upstream_error");
    expect(text.toLowerCase()).not.toContain("deepseek");
  });
});
