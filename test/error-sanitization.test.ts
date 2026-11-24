import { describe, expect, it } from "vitest";
import { mintVirtualKey, sha256Hex } from "../src/base64";
import type { Env } from "../src/config";
import { readConfig } from "../src/config";
import {
  FREE_MANAGED_MODEL_ID,
  MANAGED_MODEL_ALIAS,
  PRODUCT_ID_FREE,
  PRODUCT_ID_PRO,
  STATUS,
} from "../src/constants";
import { handleChatCompletions } from "../src/proxy";
import { newKeyRecord, putKeyRecord } from "../src/store";
import { fakeKv } from "./fake-kv";

/**
 * Regression suite for the error-sanitization contract.
 *
 * The upstream is a private implementation detail. A provider's raw error body is the single
 * easiest way for its name, host and occasionally its view of the credential to leak into a
 * customer-visible surface, so every non-2xx upstream answer is mapped to a fixed Gestu body and
 * the assertion here is *absence*: none of the provider's words may survive.
 */
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

/** Every string that must never reach a client, in any casing. */
const FORBIDDEN = ["deepseek", "gemini", "generativelanguage", "api.deepseek.com", "sk-upstream-secret", "vertex"];

const env: Env = {
  PRO_KV: fakeKv(),
  GESTU_ALLOWED_PACKAGE_NAMES: "com.gestu.app",
  UPSTREAM_API_KEY: "sk-upstream-secret",
  UPSTREAM_BASE_URL: "https://api.deepseek.com",
  UPSTREAM_MODEL_ID: "deepseek-flash",
  GEMINI_FREE_API_KEY: "sk-gemini-free-secret",
};

async function seed(productId: string): Promise<{ vKey: string; kv: Env["PRO_KV"] }> {
  const kv = fakeKv();
  const vKey = mintVirtualKey();
  const keyId = await sha256Hex(vKey);
  const meterId = productId === PRODUCT_ID_FREE ? `free-device:${keyId}` : keyId;
  await putKeyRecord(kv, {
    ...newKeyRecord({
      keyId,
      packageName: "com.gestu.app",
      productId,
      obfuscatedAccountId: "",
      expiresAt: 0,
      status: STATUS.ACTIVE,
      playState: "",
      latestOrderId: "",
      deviceId: "dev-1",
      deviceLimit: 2,
      now: NOW,
    }),
    meterId,
  });
  return { vKey, kv };
}

async function callWithUpstream(
  productId: string,
  modelId: string,
  upstreamStatus: number,
  upstreamBody: string,
  upstreamHeaders: Record<string, string> = {},
  ip = "203.0.113.20",
): Promise<Response> {
  const { vKey, kv } = await seed(productId);
  const localEnv: Env = { ...env, PRO_KV: kv };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(upstreamBody, {
      status: upstreamStatus,
      headers: { "content-type": "application/json", ...upstreamHeaders },
    })) as typeof fetch;
  try {
    return await handleChatCompletions(
      new Request("https://api.gestu.ca/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${vKey}`,
          "content-type": "application/json",
          "cf-connecting-ip": ip,
        },
        body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }] }),
      }),
      localEnv,
      readConfig(localEnv),
      NOW,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function expectNoLeak(response: Response, serialized: { body: string; headers: string }): void {
  const haystack = `${serialized.body}\n${serialized.headers}`.toLowerCase();
  for (const needle of FORBIDDEN) {
    expect(haystack, `response must not contain "${needle}"`).not.toContain(needle);
  }
  // A stable Gestu error shape is required so the app's parser keeps working.
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("X-Gestu-Quota-Limit")).not.toBeNull();
}

describe("upstream errors are sanitized before they reach a client", () => {
  it("masks a Pro provider auth failure (which names the provider and the key) as a clean 503", async () => {
    const upstreamBody = JSON.stringify({
      error: {
        message: "Incorrect API key provided: sk-upstream-...-secret. See https://api.deepseek.com/docs",
        type: "authentication_error",
        provider: "deepseek",
      },
    });
    const res = await callWithUpstream(PRODUCT_ID_PRO, MANAGED_MODEL_ALIAS, 401, upstreamBody, {
      "x-provider": "deepseek",
      server: "DeepSeek",
    });
    const body = await res.text();
    expect(res.status).toBe(503);
    expectNoLeak(res, { body, headers: JSON.stringify([...res.headers.entries()]) });
    const parsed = JSON.parse(body) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("upstream_unavailable");
    expect(parsed.error.message).toContain("managed model service");
  });

  it("masks a Pro provider balance failure (402) as a clean 503 and does not echo the provider text", async () => {
    const res = await callWithUpstream(
      PRODUCT_ID_PRO,
      MANAGED_MODEL_ALIAS,
      402,
      JSON.stringify({ error: { message: "Insufficient Balance on deepseek account", type: "payment_required" } }),
    );
    const body = await res.text();
    expect(res.status).toBe(503);
    expectNoLeak(res, { body, headers: JSON.stringify([...res.headers.entries()]) });
  });

  it("maps a provider 400 to a clean 400 without echoing the provider body", async () => {
    const res = await callWithUpstream(
      PRODUCT_ID_PRO,
      MANAGED_MODEL_ALIAS,
      400,
      JSON.stringify({
        error: {
          message: "deepseek-flash rejected this request: invalid thinking budget (provider deepseek)",
          type: "invalid_request_error",
        },
      }),
    );
    const body = await res.text();
    expect(res.status).toBe(400);
    expectNoLeak(res, { body, headers: JSON.stringify([...res.headers.entries()]) });
  });

  it("maps a provider 429 to a retryable 503, never to our quota 429", async () => {
    const res = await callWithUpstream(
      PRODUCT_ID_PRO,
      MANAGED_MODEL_ALIAS,
      429,
      JSON.stringify({ error: { message: "Rate limit reached for deepseek", code: "rate_limit_exceeded" } }),
    );
    const body = await res.text();
    // Our 429 is the app's "allowance spent" signal; a provider throttle is not that.
    expect(res.status).toBe(503);
    expectNoLeak(res, { body, headers: JSON.stringify([...res.headers.entries()]) });
  });

  it("maps a provider 5xx to a retryable 502", async () => {
    const res = await callWithUpstream(
      PRODUCT_ID_PRO,
      MANAGED_MODEL_ALIAS,
      500,
      JSON.stringify({ error: { message: "Internal error at api.deepseek.com", id: "req-1" } }),
    );
    const body = await res.text();
    expect(res.status).toBe(502);
    expectNoLeak(res, { body, headers: JSON.stringify([...res.headers.entries()]) });
  });

  it("masks a Free provider auth failure (which mentions the Generative Language API) as a clean 503", async () => {
    const res = await callWithUpstream(
      PRODUCT_ID_FREE,
      FREE_MANAGED_MODEL_ID,
      403,
      JSON.stringify({
        error: {
          code: 403,
          message: "Method doesn't allow unregistered callers. Please pass a valid API key to generativelanguage.googleapis.com",
          status: "PERMISSION_DENIED",
        },
      }),
    );
    const body = await res.text();
    expect(res.status).toBe(503);
    expectNoLeak(res, { body, headers: JSON.stringify([...res.headers.entries()]) });
  });

  it("turns a network failure into a clean 502 with no provider host in the body", async () => {
    const { vKey, kv } = await seed(PRODUCT_ID_PRO);
    const localEnv: Env = { ...env, PRO_KV: kv };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED api.deepseek.com:443");
    }) as typeof fetch;
    try {
      const res = await handleChatCompletions(
        new Request("https://api.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${vKey}`,
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.21",
          },
          body: JSON.stringify({ model: MANAGED_MODEL_ALIAS, messages: [{ role: "user", content: "hi" }] }),
        }),
        localEnv,
        readConfig(localEnv),
        NOW,
      );
      const body = await res.text();
      expect(res.status).toBe(502);
      expectNoLeak(res, { body, headers: JSON.stringify([...res.headers.entries()]) });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sanitizes an error frame that arrives inside an HTTP 200 event stream", async () => {
    const { vKey, kv } = await seed(PRODUCT_ID_PRO);
    const localEnv: Env = { ...env, PRO_KV: kv };
    const originalFetch = globalThis.fetch;
    const sse =
      'data: {"id":"1","model":"deepseek-flash","choices":[{"delta":{"content":"Hi"}}]}\n\n' +
      'data: {"error":{"message":"deepseek upstream overloaded; see https://api.deepseek.com/docs","type":"server_error"}}\n\n' +
      "data: [DONE]\n\n";
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            server: "DeepSeek",
            "x-provider-request-id": "req-deepseek-1",
          },
        },
      )) as typeof fetch;
    try {
      const res = await handleChatCompletions(
        new Request("https://api.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${vKey}`,
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.22",
          },
          body: JSON.stringify({ model: MANAGED_MODEL_ALIAS, stream: true, messages: [{ role: "user", content: "hi" }] }),
        }),
        localEnv,
        readConfig(localEnv),
        NOW,
      );
      expect(res.status).toBe(200);
      const streamed = await res.text();
      const headerText = JSON.stringify([...res.headers.entries()]);
      expect(streamed).toContain("upstream_error");
      expect(streamed).toContain("managed model service returned an error");
      const haystack = `${streamed}\n${headerText}`.toLowerCase();
      for (const needle of FORBIDDEN) {
        expect(haystack, `stream must not contain "${needle}"`).not.toContain(needle);
      }
      expect(res.headers.get("server")).toBeNull();
      expect(res.headers.get("x-provider-request-id")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("masks a 200 response whose body is an error envelope, and drops provider headers", async () => {
    const res = await callWithUpstream(
      PRODUCT_ID_PRO,
      MANAGED_MODEL_ALIAS,
      200,
      JSON.stringify({
        error: {
          message: "deepseek-flash is temporarily overloaded at api.deepseek.com",
          provider: "DeepSeek",
        },
      }),
      { server: "DeepSeek", "x-provider-request-id": "req-1", "x-provider": "deepseek" },
      "203.0.113.23",
    );
    const body = await res.text();
    expect(res.status).toBe(502);
    expectNoLeak(res, { body, headers: JSON.stringify([...res.headers.entries()]) });
    expect(res.headers.get("server")).toBeNull();
    expect(res.headers.get("x-provider")).toBeNull();
  });

  it("forwards only the content type from a successful upstream, not provider headers", async () => {
    const res = await callWithUpstream(
      PRODUCT_ID_PRO,
      MANAGED_MODEL_ALIAS,
      200,
      JSON.stringify({
        id: "chatcmpl-1",
        model: "deepseek-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
      { server: "DeepSeek", "x-goog-request-id": "abc", "x-deepseek-trace": "t" },
      "203.0.113.24",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string };
    expect(body.model).toBe(MANAGED_MODEL_ALIAS);
    expect(res.headers.get("server")).toBeNull();
    expect(res.headers.get("x-goog-request-id")).toBeNull();
    expect(res.headers.get("x-deepseek-trace")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
