/**
 * Types for `issue-licence.mjs`.
 *
 * The tool is plain JavaScript on purpose — it has to run on an operator's machine with nothing
 * but Node installed — so it carries no types of its own. `tsconfig.json` does not include
 * `tools/`, but TypeScript still resolves this declaration when a test imports the `.mjs` beside
 * it, which is what keeps `npm run typecheck` clean without loosening the config.
 *
 * These declarations are a second copy of the tool's surface and can drift from it. The tests in
 * `test/licence.test.ts` are what actually pin the behaviour: they sign with the tool and verify
 * with the Worker's own verifier.
 */

export declare const LICENCE_PREFIX: string;
export declare const LICENCE_VERSION: number;
export declare const UNLIMITED_SEATS: number;

export interface LicenceKeyPair {
  privateKey: string;
  publicKey: string;
}

export interface LicenceClaimInput {
  licenceId: string;
  organisation: string;
  issuedAt: number;
  expiresAt: number;
  seats: number;
  invoiceRef: string;
  kid?: string;
}

export interface ToolLicenceClaims {
  v: number;
  lic: string;
  org: string;
  iat: number;
  exp: number;
  seats: number;
  ref: string;
  kid?: string;
}

export declare function computeKeyId(pem: string): string;

export declare function base64Url(bytes: Uint8Array): string;

export declare function buildClaims(input: LicenceClaimInput): ToolLicenceClaims;

export declare function signingInput(claims: ToolLicenceClaims): string;

export declare function buildLicenceToken(claims: ToolLicenceClaims, privateKeyPem: string): string;

export declare function generateLicenceKeyPair(): LicenceKeyPair;

export declare function addMonths(from: number, months: number): number;

