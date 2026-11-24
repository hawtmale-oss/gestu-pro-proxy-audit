#!/usr/bin/env node
/**
 * Issues an organisational licence — the B2B half of the plan, which never touches Google Play.
 *
 * A business is invoiced (for this operator, through Venn), the invoice clears, and someone runs
 * this to mint the licence the customer pastes into Settings. Nothing here talks to the network:
 * the private key stays on the operator's machine, which is the whole reason a leaked Worker or a
 * compromised deploy cannot mint licences.
 *
 * ## Usage
 *
 *   node tools/issue-licence.mjs keygen --out gestu-licence
 *   node tools/issue-licence.mjs issue --key gestu-licence-private.pem \
 *       --id acme-2026 --org "Acme Corp" --months 12 --seats 5 --ref INV-1042
 *
 * `keygen` writes two files and is run **once**. `issue` prints a token and touches nothing.
 *
 * ## Why this is JavaScript beside a TypeScript Worker
 *
 * It has to run on an operator's machine with nothing but Node installed — no build step, no
 * toolchain, no `npm install`. That means it cannot import `src/licence.ts`. The format is
 * therefore written twice, and `test/licence.test.ts` exists to make the duplication safe: it
 * signs a licence with these functions and verifies it with the Worker's own verifier, so a format
 * change on either side fails the suite rather than the customer.
 *
 * ## The one non-obvious line
 *
 * `dsaEncoding: "ieee-p1363"`. WebCrypto's ECDSA signatures are the raw `r||s` pair; Node's
 * default is ASN.1/DER. Omit it and every licence this tool issues is refused by the Worker with
 * nothing in either log to explain why.
 */

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** Must match `LICENCE_PREFIX` in `src/constants.ts`. Pinned by `test/licence.test.ts`. */
export const LICENCE_PREFIX = "GESTU1.";

/** Must match `LICENCE_VERSION` in `src/licence.ts`. Pinned by `test/licence.test.ts`. */
export const LICENCE_VERSION = 1;

/**
 * `seats` value meaning "no device cap" — the business tier. Must match `UNLIMITED_SEATS` in
 * `src/licence.ts`, which `test/licence.test.ts` pins.
 *
 * Its own flag rather than a magic `--seats` value, so nobody writes it by mistyping a count.
 */
export const UNLIMITED_SEATS = -1;

/** base64url without padding, per RFC 4648 §5 — the encoding the Worker decodes. */
export function base64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Computes a short deterministic key ID from a PEM key. */
export function computeKeyId(pem) {
  return createHash("sha256").update(pem.trim()).digest("hex").slice(0, 12);
}

/**
 * Builds the claims object in a fixed field order.
 *
 * The order matters only because [signingInput] serialises this object verbatim: whatever order
 * is used here is the order that gets signed, and the Worker verifies the received bytes rather
 * than re-serialising anything, so the two can never disagree.
 */
export function buildClaims({ licenceId, organisation, issuedAt, expiresAt, seats, invoiceRef, kid }) {
  const claims = {
    v: LICENCE_VERSION,
    lic: licenceId,
    org: organisation,
    iat: issuedAt,
    exp: expiresAt,
    seats,
    ref: invoiceRef,
  };
  if (kid !== undefined && kid !== "") {
    claims.kid = kid;
  }
  return claims;
}

/** The exact string an issuer signs. The signature covers this and nothing else. */
export function signingInput(claims) {
  return `${LICENCE_PREFIX}${base64Url(Buffer.from(JSON.stringify(claims), "utf8"))}`;
}

/** Signs [claims] with an EC P-256 private key in PKCS#8 PEM form, returning the pasteable token. */
export function buildLicenceToken(claims, privateKeyPem) {
  const input = signingInput(claims);
  const signature = sign("sha256", Buffer.from(input, "utf8"), {
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${base64Url(signature)}`;
}

/**
 * Generates the signing key pair.
 *
 * P-256 rather than Ed25519 only because Cloudflare's WebCrypto support for Ed25519 is the newer
 * of the two; both would be fine, and one curve is easier to reason about than two.
 */
export function generateLicenceKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey, publicKey };
}

/** Adds whole months to `from`, clamping the day so 31 January + 1 month is not 3 March. */
export function addMonths(from, months) {
  const date = new Date(from);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

const USAGE = `gestu licence issuer

  node tools/issue-licence.mjs keygen [--out <prefix>] [--kid <id>]
      Writes <prefix>-private.pem and <prefix>-public.pem. Run once, ever.

  node tools/issue-licence.mjs issue --key <private.pem> --id <licence id> --org <name>
        [--months N | --days N | --perpetual] <--seats N | --unlimited> [--ref <invoice>] [--kid <id>]
      Prints the licence token to hand to the customer.`;

function fail(message) {
  console.error(`issue-licence: ${message}`);
  console.error("");
  console.error(USAGE);
  process.exitCode = 1;
}

function runKeygen(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: "string", default: "gestu-licence" },
      kid: { type: "string" },
    },
    allowPositionals: false,
  });
  const prefix = values.out;
  const { privateKey, publicKey } = generateLicenceKeyPair();
  const kid = values.kid && values.kid.trim() !== "" ? values.kid.trim() : computeKeyId(publicKey);
  writeFileSync(`${prefix}-private.pem`, privateKey, { mode: 0o600 });
  writeFileSync(`${prefix}-public.pem`, publicKey, { mode: 0o644 });
  console.log(`Wrote ${prefix}-private.pem and ${prefix}-public.pem.`);
  console.log(`Key ID (kid): ${kid}`);
  console.log("");
  console.log("Keep the private key off every server. Back it up somewhere you would keep a");
  console.log("signing key: losing it means every future licence needs a new key pair, and");
  console.log("leaking it means anyone can mint licences you will be billed for.");
  console.log("");
  console.log("Publish the public key as the Worker secret GESTU_LICENCE_PUBLIC_KEY, or map it");
  console.log(`in GESTU_LICENCE_PUBLIC_KEYS under "${kid}":`);
  console.log("");
  console.log(publicKey.trim());
}

function runIssue(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      key: { type: "string" },
      id: { type: "string" },
      org: { type: "string" },
      months: { type: "string" },
      days: { type: "string" },
      perpetual: { type: "boolean", default: false },
      unlimited: { type: "boolean", default: false },
      seats: { type: "string" },
      ref: { type: "string", default: "" },
      kid: { type: "string" },
    },
    allowPositionals: false,
  });

  for (const required of ["key", "id", "org"]) {
    if (values[required] === undefined || values[required] === "") {
      fail(`--${required} is required`);
      return;
    }
  }

  const now = Date.now();
  let expiresAt = 0;
  if (!values.perpetual) {
    const months = values.months === undefined ? 12 : Number(values.months);
    const days = values.days === undefined ? 0 : Number(values.days);
    if (!Number.isFinite(months) || !Number.isFinite(days) || (months <= 0 && days <= 0)) {
      fail("--months and --days must be positive numbers, or pass --perpetual");
      return;
    }
    expiresAt = addMonths(now, months) + days * 86_400_000;
  }

  // `--unlimited` and `--seats` are two answers to one question, so asking for both is an operator
  // mistake rather than something to resolve by precedence.
  if (values.unlimited && values.seats !== undefined) {
    fail("--unlimited and --seats cannot both be given");
    return;
  }
  if (!values.unlimited && values.seats === undefined) {
    fail("either --seats <N> or --unlimited must be specified (defaulting to 0 is disabled to prevent silently capping seats)");
    return;
  }
  const seats = values.unlimited ? UNLIMITED_SEATS : Number(values.seats);
  if (!Number.isFinite(seats) || (seats !== UNLIMITED_SEATS && seats < 0)) {
    fail("--seats must be zero or a positive number; use --unlimited for no cap");
    return;
  }

  let privateKeyPem;
  try {
    privateKeyPem = readFileSync(values.key, "utf8");
  } catch {
    fail(`could not read the private key at ${values.key}`);
    return;
  }

  const kid = values.kid && values.kid.trim() !== "" ? values.kid.trim() : computeKeyId(privateKeyPem);

  const claims = buildClaims({
    licenceId: values.id,
    organisation: values.org,
    issuedAt: now,
    expiresAt,
    seats: Math.floor(seats),
    invoiceRef: values.ref,
    kid,
  });

  console.log(buildLicenceToken(claims, privateKeyPem));
  console.error("");
  console.error(`  licence   ${claims.lic}`);
  if (claims.kid) console.error(`  kid       ${claims.kid}`);
  console.error(`  org       ${claims.org}`);
  console.error(`  issued    ${new Date(claims.iat).toISOString()}`);
  console.error(`  expires   ${claims.exp === 0 ? "never" : new Date(claims.exp).toISOString()}`);
  console.error(`  seats     ${claims.seats === UNLIMITED_SEATS ? "unlimited" : claims.seats === 0 ? "server default" : claims.seats}`);
  if (claims.ref !== "") console.error(`  invoice   ${claims.ref}`);
  console.error("");
  console.error("The token above is what the customer pastes into Settings. It is not a secret:");
  console.error("it is signed, so it cannot be altered, and it is useless without this server.");
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "keygen":
      runKeygen(rest);
      return;
    case "issue":
      runIssue(rest);
      return;
    default:
      fail(command === undefined ? "no command given" : `unknown command "${command}"`);
  }
}

// Importable by the test suite without running the CLI.
//
// `pathToFileURL` rather than string-concatenating `file://`: on Windows the hand-built form comes
// out as `file://C:/…` while `import.meta.url` is `file:///C:/…`, so the comparison silently fails
// and the tool appears to do nothing at all — no output, no error, exit 0.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
