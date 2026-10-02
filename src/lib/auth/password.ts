import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Password hashing with scrypt.
 *
 * scrypt is used rather than a native argon2 binding for a deliberate reason: it ships inside
 * Node itself. A trust product should not depend on a prebuilt native binary being available
 * for whatever platform it is deployed to, because the failure mode is either a build toolchain
 * requirement at deploy time or a silent fallback to something weaker. scrypt is memory hard,
 * standardised in RFC 7914, and with these parameters costs an attacker roughly 32 MB of memory
 * per guess, which is what defeats commodity GPU cracking.
 *
 * Parameters are stored inside the hash string so they can be raised later without invalidating
 * existing passwords: an old hash still verifies with its own recorded cost, and can be upgraded
 * transparently on the next successful sign in.
 */

const COST = 2 ** 15; // N, the CPU and memory cost.
const BLOCK_SIZE = 8; // r
const PARALLELISM = 1; // p
const KEY_BYTES = 64;
const SALT_BYTES = 16;

// scrypt needs roughly 128 * N * r bytes. Node's default cap of 32 MB is just under what these
// parameters require, so the limit is raised explicitly rather than silently weakening the cost.
const MAX_MEMORY = 128 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(password.normalize('NFKC'), salt, KEY_BYTES, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: MAX_MEMORY,
  })) as Buffer;

  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a candidate password.
 *
 * Returns false for any malformed stored hash rather than throwing, so a corrupted user record
 * fails closed as a rejected sign in instead of surfacing an internal error to an attacker.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelism = Number(parts[3]);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelism)) {
    return false;
  }
  // Refuse to spend unbounded memory because a stored record claimed an enormous cost.
  if (cost > 2 ** 20 || blockSize > 32 || parallelism > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = (await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N: cost,
    r: blockSize,
    p: parallelism,
    maxmem: MAX_MEMORY,
  })) as Buffer;

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** True when a stored hash was produced with weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  return parts[0] !== 'scrypt' || Number(parts[1]) < COST;
}
