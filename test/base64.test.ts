import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode, looksLikeVirtualKey, mintVirtualKey, sha256Hex, timingSafeEqual, toHex, utf8 } from "../src/base64";

describe("base64UrlEncode", () => {
  it("emits the RFC 4648 §5 alphabet with no padding", () => {
    // Vectors taken from RFC 4648 §10, translated to base64url and stripped of `=`.
    expect(base64UrlEncode(utf8(""))).toBe("");
    expect(base64UrlEncode(utf8("f"))).toBe("Zg");
    expect(base64UrlEncode(utf8("fo"))).toBe("Zm8");
    expect(base64UrlEncode(utf8("foo"))).toBe("Zm9v");
    expect(base64UrlEncode(utf8("foob"))).toBe("Zm9vYg");
    expect(base64UrlEncode(utf8("fooba"))).toBe("Zm9vYmE");
    expect(base64UrlEncode(utf8("foobar"))).toBe("Zm9vYmFy");
  });

  it("uses - and _ rather than + and /", () => {
    // 0xfb 0xff encodes to "+/8=" in standard base64 and "-_8" in base64url.
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  it("round-trips through the decoder, including padded standard base64", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i;
    const encoded = base64UrlEncode(bytes);
    expect(Array.from(base64UrlDecode(encoded))).toEqual(Array.from(bytes));
    // Google's Pub/Sub delivers ordinary base64, sometimes padded and sometimes with +/.
    expect(Array.from(base64UrlDecode("Zm9vYg=="))).toEqual(Array.from(utf8("foob")));
    expect(Array.from(base64UrlDecode("-_8="))).toEqual([0xfb, 0xff]);
  });
});

describe("toHex", () => {
  it("pads each byte to two lowercase digits", () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff");
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of the empty string", () => {
    return expect(sha256Hex("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic and 64 hex characters", async () => {
    const digest = await sha256Hex("msk_example");
    expect(digest).toHaveLength(64);
    expect(digest).toBe(await sha256Hex("msk_example"));
    expect(digest).not.toBe(await sha256Hex("msk_examplE"));
  });
});

describe("mintVirtualKey", () => {
  it("has the gsk_ prefix and 256 bits of base64url payload", () => {
    const key = mintVirtualKey();
    expect(key.startsWith("gsk_")).toBe(true);
    expect(key.slice(4)).toHaveLength(43);
    expect(looksLikeVirtualKey(key)).toBe(true);
    expect(Array.from(base64UrlDecode(key.slice(4)))).toHaveLength(32);
  });

  it("never repeats", () => {
    const keys = new Set(Array.from({ length: 256 }, () => mintVirtualKey()));
    expect(keys.size).toBe(256);
  });
});

describe("looksLikeVirtualKey", () => {
  it("rejects anything that is not a plausible key", () => {
    expect(looksLikeVirtualKey("")).toBe(false);
    expect(looksLikeVirtualKey("sk-personal")).toBe(false);
    expect(looksLikeVirtualKey("msk_short")).toBe(false);
    expect(looksLikeVirtualKey("gsk_short")).toBe(false);
    expect(looksLikeVirtualKey(`msk_${"a".repeat(200)}`)).toBe(false);
    expect(looksLikeVirtualKey(`gsk_${"a".repeat(200)}`)).toBe(false);
    expect(looksLikeVirtualKey(`gsk_${"a".repeat(43)}`)).toBe(true);
    expect(looksLikeVirtualKey(`msk_${"a".repeat(43)}`)).toBe(true);
  });
});

describe("timingSafeEqual", () => {
  it("compares equal and unequal strings, and length mismatches", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});
