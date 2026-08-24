import type { Readable } from 'node:stream';
import { env } from '@/lib/env';
import { newId } from '@/lib/util/crypto';
import { localDriver } from '@/lib/storage/local';
import { s3Driver } from '@/lib/storage/s3';

/**
 * Object storage abstraction.
 *
 * Signet stores three kinds of object: the uploaded original, signature and initials images,
 * and the final sealed document. All three are encrypted by the application before they reach
 * the driver (see `crypto.ts`), so a driver only ever handles opaque ciphertext. That keeps the
 * security property independent of which backend is configured, and it means switching from
 * local disk to a bucket changes durability without changing the threat model.
 */

export type StorageDriver = {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Whole object, decrypted. Use for anything that must be processed in memory. */
  get(key: string): Promise<Buffer>;
  /** Streaming read, decrypted on the fly. Use for downloads. */
  stream(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  /**
   * Present for completeness and for removing orphaned draft uploads. Signed documents are
   * never deleted by the application: they are legal records with an indefinite retention.
   */
  remove(key: string): Promise<void>;
};

/**
 * Storage keys are generated here and never accepted from a client.
 *
 * The shape is `<scope>/<envelopeId>/<kind>-<random>.<ext>`. The random component means a key
 * cannot be guessed from an envelope id, which matters for the S3 driver where an accidental
 * public bucket policy would otherwise expose predictable object names.
 */
export function storageKey(
  scope: 'envelopes',
  envelopeId: string,
  kind: 'original' | 'sealed' | 'signature' | 'initials',
  extension: 'pdf' | 'png',
): string {
  return `${scope}/${envelopeId}/${kind}-${newId()}.${extension}`;
}

/** Reject anything that could escape the storage root or address a parent directory. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_-]{0,190}\.(pdf|png)$/;

export function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes('..') || key.includes('//')) {
    throw new Error('Refusing to touch an unsafe storage key.');
  }
}

let cached: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (!cached) {
    cached = env().STORAGE_DRIVER === 's3' ? s3Driver() : localDriver();
  }
  return cached;
}

/** Reset the cached driver. Tests only. */
export function resetStorageCache(): void {
  cached = null;
}
