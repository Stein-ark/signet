import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '@/lib/env';

/**
 * Primitives shared by every part of Signet that has to prove something.
 *
 * Two rules govern this file:
 *   1. Anything we store in order to look a credential up later is stored as a keyed hash, not
 *      as the credential itself. A database leak must not hand an attacker working signing
 *      links or passcodes.
 *   2. Anything compared against a user supplied value is compared in constant time, so that
 *      response timing cannot be used to recover a secret one byte at a time.
 */

/** Bytes of entropy in a signing link token. 32 bytes is 256 bits, far beyond guessable. */
const TOKEN_BYTES = 32;

/** Characters used for the URL safe encoding. Base64url avoids padding and escaping issues. */
function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/**
 * Create a new high entropy, single purpose credential.
 *
 * Returns the raw value (shown once, embedded in a link or a cookie, never persisted) and the
 * peppered hash (persisted and indexed).
 */
export function createSecretToken(purpose: TokenPurpose): { token: string; hash: string } {
  const token = toBase64Url(randomBytes(TOKEN_BYTES));
  return { token, hash: hashSecret(token, purpose) };
}

/**
 * Purposes are baked into the hash so a credential minted for one job can never be replayed
 * as another. A stolen signing link cannot be presented as an owner session cookie even if an
 * attacker could somehow write it into the sessions collection.
 */
export type TokenPurpose = 'signing-link' | 'owner-session' | 'signing-session' | 'otp';

/** Keyed hash of a secret. The pepper lives in the environment, not the database. */
export function hashSecret(secret: string, purpose: TokenPurpose): string {
  return createHmac('sha256', Buffer.from(env().APP_SECRET, 'base64'))
    .update(`${purpose}:${secret}`)
    .digest('hex');
}

/** Constant time string comparison that tolerates differing lengths without leaking them. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = createHash('sha256').update(a).digest();
  const bufferB = createHash('sha256').update(b).digest();
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * A six digit one time passcode.
 *
 * randomInt is used rather than Math.random because passcodes are an authentication factor.
 * Leading zeros are preserved so the code always has six characters.
 */
export function createOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** SHA-256 of arbitrary bytes, hex encoded. Used for document fingerprints. */
export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Stable identifier for embedded subdocuments (recipients, fields). */
export function newId(): string {
  return randomUUID();
}

/**
 * Deterministic JSON serialisation with sorted keys.
 *
 * The audit hash chain must produce the same hash for the same event on every machine and
 * every Node version, so key order can never be left to chance.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}
