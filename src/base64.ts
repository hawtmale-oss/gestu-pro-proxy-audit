/**
 * Encoding helpers, all pure and all testable without a Workers runtime.
 *
 * They exist because JWT signing and key hashing both need base64url *without* padding, which
 * `btoa` does not do, and because a shared implementation is the only way the virtual-key format
 * and its hash stay consistent between minting and lookup.
 */

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * base64url-encodes bytes with no `=` padding, per RFC 4648 §5.
 *
 * Implemented by hand rather than by converting to a binary string and calling `btoa`: `btoa`
 * needs a Latin-1 string (an extra pass, and a place for a stray code point to corrupt a JWT
 * signature), and this version is trivially unit-testable against known vectors.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : -1;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : -1;

    out += BASE64URL_ALPHABET[b0 >> 2];
    if (b1 < 0) {
      out += BASE64URL_ALPHABET[(b0 & 0x03) << 4];
      break;
    }
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (b2 < 0) {
      out += BASE64URL_ALPHABET[(b1 & 0x0f) << 2];
      break;
    }
    out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    out += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** UTF-8 encodes text the way every JSON/JWT producer does. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Lowercase hex, the form used for the KV key of a hashed credential. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * base64url-decodes a string, tolerating padding and the standard `+`/`-` alphabets.
 *
 * Used for Google's Pub/Sub `message.data` (which is ordinary base64, sometimes with padding)
 * and for the JWT segments we verify on the RTDN path.
 */
export function base64UrlDecode(text: string): Uint8Array {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const unpadded = normalized.replace(/=+$/, "");
  const remainder = unpadded.length % 4;
  if (remainder === 1) throw new Error("invalid base64 length");
  const padded = unpadded + "=".repeat((4 - remainder) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** SHA-256 of the UTF-8 form of `text`, lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(text));
  return toHex(new Uint8Array(digest));
}

/**
 * Constant-time string comparison.
 *
 * Used to compare a presented virtual key's hash against a stored one. A plain `===` on hashes
 * leaks timing; on a hash the leak is not directly exploitable, but this costs nothing and keeps
 * the habit in one place.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when `value` looks like a virtual key this Worker could have minted. */
export function looksLikeVirtualKey(value: string): boolean {
  return (value.startsWith("gsk_") || value.startsWith("msk_")) && value.length >= 20 && value.length <= 128;
}

/**
 * Generates a virtual key: `gsk_` plus base64url of 32 CSPRNG bytes (256 bits).
 *
 * `crypto.getRandomValues` is the platform CSPRNG; no Math.random anywhere on this path.
 */
export function mintVirtualKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `gsk_${base64UrlEncode(bytes)}`;
}
