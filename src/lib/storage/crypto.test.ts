import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { HEADER_BYTES, decryptBuffer, decryptStream, encryptBuffer } from '@/lib/storage/crypto';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Feed a buffer in small, uneven chunks so the header straddles chunk boundaries. */
function chunked(buffer: Buffer, size = 7): Readable {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) parts.push(buffer.subarray(offset, offset + size));
  return Readable.from(parts);
}

describe('storage envelope encryption', () => {
  const originalKey = process.env.STORAGE_ENCRYPTION_KEY;
  afterEach(() => {
    process.env.STORAGE_ENCRYPTION_KEY = originalKey;
    resetEnvCache();
  });

  it('round trips a buffer and never stores the plaintext', () => {
    const plaintext = Buffer.from('%PDF-1.7 confidential agreement body');
    const blob = encryptBuffer(plaintext);
    expect(blob.subarray(0, 4).toString('ascii')).toBe('SGT1');
    expect(blob.includes(plaintext)).toBe(false);
    expect(decryptBuffer(blob)).toEqual(plaintext);
  });

  it('uses a fresh data key and IV for every object', () => {
    const plaintext = Buffer.from('same input');
    expect(encryptBuffer(plaintext).equals(encryptBuffer(plaintext))).toBe(false);
  });

  it('rejects a modified ciphertext byte', () => {
    const blob = encryptBuffer(randomBytes(256));
    blob[HEADER_BYTES + 10]! ^= 0x01;
    expect(() => decryptBuffer(blob)).toThrow();
  });

  it('rejects a modified wrapped key', () => {
    const blob = encryptBuffer(randomBytes(64));
    blob[40]! ^= 0x01;
    expect(() => decryptBuffer(blob)).toThrow();
  });

  it('rejects a truncated object', () => {
    const blob = encryptBuffer(randomBytes(64));
    expect(() => decryptBuffer(blob.subarray(0, HEADER_BYTES - 1))).toThrow(/truncated/);
  });

  it('cannot be opened with a different master key', () => {
    const blob = encryptBuffer(randomBytes(64));
    process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    resetEnvCache();
    expect(() => decryptBuffer(blob)).toThrow();
  });

  it('decrypts a stream delivered in arbitrary chunks', async () => {
    const plaintext = randomBytes(10_000);
    const output = await collect(decryptStream(chunked(encryptBuffer(plaintext))));
    expect(output).toEqual(plaintext);
  });

  it('fails a stream whose ciphertext was tampered with', async () => {
    const blob = encryptBuffer(randomBytes(2_000));
    blob[blob.length - 1]! ^= 0xff;
    await expect(collect(decryptStream(chunked(blob, 512)))).rejects.toThrow();
  });

  it('fails a stream that ends inside the header', async () => {
    const blob = encryptBuffer(randomBytes(100));
    await expect(collect(decryptStream(chunked(blob.subarray(0, 20))))).rejects.toThrow(/header/);
  });
});
