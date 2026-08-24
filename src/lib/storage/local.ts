import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { env } from '@/lib/env';
import { decryptBuffer, decryptStream, encryptBuffer } from '@/lib/storage/crypto';
import { assertValidKey, type StorageDriver } from '@/lib/storage/index';

/**
 * Filesystem backed object storage.
 *
 * This is the default driver so the application runs correctly on a single machine with no
 * cloud account, and it is a legitimate production choice when the disk itself is durable and
 * backed up. Bytes on disk are ciphertext, exactly as they would be in a bucket, so the local
 * driver is not a weaker security posture, only a weaker durability posture.
 */
export function localDriver(): StorageDriver {
  const root = path.resolve(process.cwd(), env().STORAGE_LOCAL_DIR);

  /**
   * Resolve a storage key to an absolute path and prove it stays inside the storage root.
   * The key is validated first, but the containment check is kept as a second, independent
   * guard so a future change to the key format cannot silently create a path traversal.
   */
  function resolveKey(key: string): string {
    assertValidKey(key);
    const target = path.resolve(root, key);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (!target.startsWith(rootWithSep)) {
      throw new Error('Refusing to touch a path outside the storage root.');
    }
    return target;
  }

  return {
    name: 'local',

    async put(key, body, _contentType) {
      const target = resolveKey(key);
      await mkdir(path.dirname(target), { recursive: true });
      // Write to a temporary neighbour then rename, so a crash mid write can never leave a
      // half written document behind a key the database already believes is complete.
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, encryptBuffer(body), { mode: 0o600 });
      const { rename } = await import('node:fs/promises');
      await rename(temporary, target);
    },

    async get(key) {
      return decryptBuffer(await readFile(resolveKey(key)));
    },

    async stream(key): Promise<Readable> {
      return decryptStream(createReadStream(resolveKey(key)));
    },

    async exists(key) {
      try {
        await stat(resolveKey(key));
        return true;
      } catch {
        return false;
      }
    },

    async remove(key) {
      await rm(resolveKey(key), { force: true });
    },
  };
}
