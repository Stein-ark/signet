import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { env } from '@/lib/env';

/**
 * Envelope encryption for every object Signet stores.
 *
 * Documents here are legal agreements containing personal data, so nothing is written to disk
 * or to a bucket in the clear, regardless of what the underlying storage claims to do. Server
 * side encryption at the provider protects against a stolen disk; it does not protect against
 * a misconfigured bucket policy or a compromised provider console. Encrypting before the bytes
 * leave the process means the stored object is useless without a key that only ever lives in
 * this application's environment.
 *
 * Why envelope encryption rather than encrypting straight with the master key:
 *   - every object gets its own random 256 bit data key, so a nonce reuse bug or a cryptanalytic
 *     result against one object cannot cascade to the whole corpus,
 *   - the master key can be rotated by rewrapping small data keys instead of rewriting every
 *     stored document.
 *
 * Wire format (all binary, single blob):
 *
 *   offset  size  meaning
 *   0       4     magic "SGT1"
 *   4       1     algorithm id (1 = AES-256-GCM)
 *   5       12    IV used to wrap the data key with the master key
 *   17      16    GCM tag of the wrapped data key
 *   33      32    the wrapped (encrypted) data key
 *   65      12    IV used to encrypt the payload with the data key
 *   77      16    GCM tag of the payload
 *   93      ...   ciphertext
 *
 * Putting the payload tag in the header rather than trailing it is what makes streaming
 * decryption possible: the decipher can be authenticated before the first byte is read, so a
 * download can be piped straight to the client without buffering the whole document.
 */

const MAGIC = Buffer.from('SGT1', 'ascii');
const ALG_AES_256_GCM = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
export const HEADER_BYTES = 4 + 1 + IV_BYTES + TAG_BYTES + KEY_BYTES + IV_BYTES + TAG_BYTES;

function masterKey(): Buffer {
  return Buffer.from(env().STORAGE_ENCRYPTION_KEY, 'base64');
}

/** Encrypt a whole buffer. Used for uploads, which are bounded by MAX_UPLOAD_BYTES. */
export function encryptBuffer(plaintext: Buffer): Buffer {
  const dataKey = randomBytes(KEY_BYTES);

  const dataIv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey, dataIv) as CipherGCM;
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const dataTag = cipher.getAuthTag();

  const wrapIv = randomBytes(IV_BYTES);
  const wrapCipher = createCipheriv('aes-256-gcm', masterKey(), wrapIv) as CipherGCM;
  const wrappedKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
  const wrapTag = wrapCipher.getAuthTag();

  // Wipe the plaintext data key from memory as soon as it is no longer needed.
  dataKey.fill(0);

  const header = Buffer.alloc(HEADER_BYTES);
  let offset = 0;
  MAGIC.copy(header, offset);
  offset += MAGIC.length;
  header.writeUInt8(ALG_AES_256_GCM, offset);
  offset += 1;
  wrapIv.copy(header, offset);
  offset += IV_BYTES;
  wrapTag.copy(header, offset);
  offset += TAG_BYTES;
  wrappedKey.copy(header, offset);
  offset += KEY_BYTES;
  dataIv.copy(header, offset);
  offset += IV_BYTES;
  dataTag.copy(header, offset);

  return Buffer.concat([header, ciphertext]);
}

type ParsedHeader = { dataKey: Buffer; dataIv: Buffer; dataTag: Buffer };

function parseHeader(header: Buffer): ParsedHeader {
  if (header.length < HEADER_BYTES) {
    throw new Error('Stored object is truncated: encryption header is incomplete.');
  }
  if (!header.subarray(0, 4).equals(MAGIC)) {
    throw new Error('Stored object is not a Signet encrypted blob.');
  }
  if (header.readUInt8(4) !== ALG_AES_256_GCM) {
    throw new Error('Stored object uses an unsupported encryption algorithm.');
  }

  let offset = 5;
  const wrapIv = header.subarray(offset, (offset += IV_BYTES));
  const wrapTag = header.subarray(offset, (offset += TAG_BYTES));
  const wrappedKey = header.subarray(offset, (offset += KEY_BYTES));
  const dataIv = header.subarray(offset, (offset += IV_BYTES));
  const dataTag = header.subarray(offset, (offset += TAG_BYTES));

  const unwrap = createDecipheriv('aes-256-gcm', masterKey(), wrapIv) as DecipherGCM;
  unwrap.setAuthTag(wrapTag);
  // If the master key is wrong or the header was tampered with, final() throws here and no
  // payload byte is ever processed.
  const dataKey = Buffer.concat([unwrap.update(wrappedKey), unwrap.final()]);

  return { dataKey, dataIv, dataTag };
}

/** Decrypt a whole buffer. Throws if the blob was modified in any way. */
export function decryptBuffer(blob: Buffer): Buffer {
  const { dataKey, dataIv, dataTag } = parseHeader(blob.subarray(0, HEADER_BYTES));
  const decipher = createDecipheriv('aes-256-gcm', dataKey, dataIv) as DecipherGCM;
  decipher.setAuthTag(dataTag);
  const plaintext = Buffer.concat([
    decipher.update(blob.subarray(HEADER_BYTES)),
    decipher.final(),
  ]);
  dataKey.fill(0);
  return plaintext;
}

/**
 * Wrap a ciphertext stream so that plaintext comes out the other end.
 *
 * The first HEADER_BYTES bytes are buffered to recover the data key, then everything after is
 * piped through the decipher. This is what lets a 25 MB document be served to a browser without
 * ever holding the whole file in memory.
 *
 * Authentication still happens: the GCM tag is verified at flush time, so a truncated or
 * tampered object ends the response with an error rather than delivering partial plaintext as
 * if it were genuine. Consumers must treat a stream error as a failed download.
 */
export function decryptStream(source: Readable): Readable {
  let header = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  let dataKey: Buffer | null = null;

  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        let body = chunk;

        if (!decipher) {
          header = Buffer.concat([header, chunk]);
          if (header.length < HEADER_BYTES) {
            callback();
            return;
          }
          const parsed = parseHeader(header.subarray(0, HEADER_BYTES));
          dataKey = parsed.dataKey;
          decipher = createDecipheriv('aes-256-gcm', parsed.dataKey, parsed.dataIv) as DecipherGCM;
          decipher.setAuthTag(parsed.dataTag);
          body = header.subarray(HEADER_BYTES);
          header = Buffer.alloc(0);
        }

        if (body.length > 0) {
          this.push(decipher.update(body));
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },

    flush(callback) {
      try {
        if (!decipher) {
          throw new Error('Stored object ended before the encryption header was complete.');
        }
        this.push(decipher.final());
        dataKey?.fill(0);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });

  source.on('error', (error) => transform.destroy(error));
  source.pipe(transform);
  return transform;
}
