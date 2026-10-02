import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { env } from '@/lib/env';
import { decryptBuffer, decryptStream, encryptBuffer } from '@/lib/storage/crypto';
import { assertValidKey, type StorageDriver } from '@/lib/storage/index';

/**
 * S3 compatible object storage, signed with AWS Signature Version 4.
 *
 * The AWS SDK is not used here on purpose. Signet needs exactly four S3 operations, and the
 * SDK would add roughly a hundred transitive packages and tens of megabytes to the deployment
 * for them. SigV4 is a well specified algorithm that fits in one readable file, so the trade
 * is a small amount of code we own against a large dependency surface we do not. This driver
 * works against AWS S3, Cloudflare R2, Backblaze B2, MinIO and anything else speaking the same
 * protocol.
 *
 * Note that the bytes handed to `put` are already encrypted by the application. The server side
 * encryption header below is an additional layer at the provider, not the layer we rely on.
 */

const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

type SignedRequest = { url: string; headers: Record<string, string> };

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** RFC 3986 percent encoding. encodeURIComponent leaves a few characters AWS expects encoded. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodePath(path: string): string {
  return path.split('/').map(uriEncode).join('/');
}

export function s3Driver(): StorageDriver {
  const config = env();
  const bucket = config.S3_BUCKET!;
  const region = config.S3_REGION;
  const accessKeyId = config.S3_ACCESS_KEY_ID!;
  const secretAccessKey = config.S3_SECRET_ACCESS_KEY!;

  const endpoint = new URL(config.S3_ENDPOINT || `https://s3.${region}.amazonaws.com`);
  const pathStyle = config.S3_FORCE_PATH_STYLE || Boolean(config.S3_ENDPOINT);

  function buildRequest(key: string, payloadHash: string, method: string, extra: Record<string, string> = {}): SignedRequest {
    const host = pathStyle ? endpoint.host : `${bucket}.${endpoint.host}`;
    const path = pathStyle ? `/${bucket}/${key}` : `/${key}`;
    const canonicalUri = encodePath(path);

    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);

    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extra,
    };

    // Every header we send that participates in the signature must be sorted and lowercased.
    const headerNames = Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort();
    const canonicalHeaders = headerNames
      .map((name) => `${name}:${String(headers[name] ?? headers[name.toLowerCase()]).trim()}\n`)
      .join('');
    const signedHeaders = headerNames.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), SERVICE),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    headers.authorization =
      `${ALGORITHM} Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    // `host` is set by fetch itself and must not be passed through.
    const { host: _host, ...outgoing } = headers;

    return { url: `${endpoint.protocol}//${host}${canonicalUri}`, headers: outgoing };
  }

  /**
   * Perform a request with a timeout and bounded retries.
   *
   * Only transient conditions are retried: network failures, 429 and 5xx. A 403 is a
   * configuration problem and retrying it just delays the error the operator needs to see.
   */
  async function send(request: SignedRequestFactory, expectBody: boolean): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        // Re sign on every attempt: a signature carries a timestamp and expires.
        const { url, headers, method, body } = request();
        const response = await fetch(url, { method, headers, body, signal: controller.signal });

        if (response.ok || response.status === 404) return response;
        if (response.status < 500 && response.status !== 429) {
          const detail = expectBody ? await response.text().catch(() => '') : '';
          throw new Error(`S3 request failed with ${response.status}. ${detail.slice(0, 300)}`);
        }
        lastError = new Error(`S3 request failed with ${response.status}`);
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new Error('S3 request timed out.');
        }
        if (attempt === MAX_ATTEMPTS) break;
      } finally {
        clearTimeout(timer);
      }

      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)));
      }
    }

    throw lastError instanceof Error ? lastError : new Error('S3 request failed.');
  }

  type SignedRequestFactory = () => {
    url: string;
    headers: Record<string, string>;
    method: string;
    body?: ArrayBuffer;
  };

  return {
    name: 's3',

    async put(key, body, contentType) {
      assertValidKey(key);
      const ciphertext = encryptBuffer(body);
      const payloadHash = sha256Hex(ciphertext);
      const requestBody = new Uint8Array(ciphertext).buffer;

      await send(() => {
        const signed = buildRequest(key, payloadHash, 'PUT', {
          'x-amz-server-side-encryption': 'AES256',
        });
        return {
          ...signed,
          method: 'PUT',
          headers: {
            ...signed.headers,
            'content-type': contentType,
            'content-length': String(ciphertext.length),
          },
          body: requestBody,
        };
      }, true);
    },

    async get(key) {
      assertValidKey(key);
      const response = await send(
        () => ({ ...buildRequest(key, 'UNSIGNED-PAYLOAD', 'GET'), method: 'GET' }),
        true,
      );
      if (response.status === 404) throw new Error(`Stored object ${key} is missing.`);
      return decryptBuffer(Buffer.from(await response.arrayBuffer()));
    },

    async stream(key) {
      assertValidKey(key);
      const response = await send(
        () => ({ ...buildRequest(key, 'UNSIGNED-PAYLOAD', 'GET'), method: 'GET' }),
        false,
      );
      if (response.status === 404 || !response.body) {
        throw new Error(`Stored object ${key} is missing.`);
      }
      return decryptStream(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]));
    },

    async exists(key) {
      assertValidKey(key);
      const response = await send(
        () => ({ ...buildRequest(key, 'UNSIGNED-PAYLOAD', 'HEAD'), method: 'HEAD' }),
        false,
      );
      return response.ok;
    },

    async remove(key) {
      assertValidKey(key);
      await send(
        () => ({ ...buildRequest(key, 'UNSIGNED-PAYLOAD', 'DELETE'), method: 'DELETE' }),
        false,
      );
    },
  };
}
