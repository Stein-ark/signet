import { MongoClient, type Db } from 'mongodb';
import { env } from '@/lib/env';

/**
 * MongoDB connection management.
 *
 * Next.js reloads modules on every edit in development, so a naive `new MongoClient()` at
 * module scope leaks a connection pool per reload until the database refuses new connections.
 * The client is therefore cached on globalThis, which survives module reloads.
 *
 * The promise itself is cached rather than the connected client, so concurrent first requests
 * share a single connect() instead of racing to open several pools.
 */

type MongoCache = {
  client: MongoClient | null;
  promise: Promise<MongoClient> | null;
  indexesReady: Promise<void> | null;
};

const globalForMongo = globalThis as typeof globalThis & { __signetMongo?: MongoCache };

const cache: MongoCache = (globalForMongo.__signetMongo ??= {
  client: null,
  promise: null,
  indexesReady: null,
});

export async function getClient(): Promise<MongoClient> {
  if (cache.client) return cache.client;

  if (!cache.promise) {
    const client = new MongoClient(env().MONGODB_URI, {
      // Fail fast rather than hanging a request for 30 seconds when the database is down.
      serverSelectionTimeoutMS: 8_000,
      connectTimeoutMS: 8_000,
      socketTimeoutMS: 45_000,
      maxPoolSize: 20,
      minPoolSize: 0,
      retryWrites: true,
      retryReads: true,
      // Documents and audit records are legal evidence, so a write is not acknowledged until
      // the majority of the replica set has it.
      writeConcern: { w: 'majority' },
      appName: 'signet',
    });

    cache.promise = client
      .connect()
      .then((connected) => {
        cache.client = connected;
        return connected;
      })
      .catch((error) => {
        // Clear the cached promise so the next request retries instead of returning the same
        // rejected promise forever.
        cache.promise = null;
        throw error;
      });
  }

  return cache.promise;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(env().MONGODB_DB);
}

/**
 * Ensure indexes exist exactly once per process.
 *
 * Called from the data access layer rather than from a build step so that a fresh deployment
 * against an empty database is correct on its very first request.
 */
export async function ensureIndexes(): Promise<void> {
  if (!cache.indexesReady) {
    cache.indexesReady = createIndexes().catch((error) => {
      cache.indexesReady = null;
      throw error;
    });
  }
  return cache.indexesReady;
}

async function createIndexes(): Promise<void> {
  const db = await getDb();

  await Promise.all([
    db.collection('users').createIndexes([
      { key: { email: 1 }, name: 'email_unique', unique: true },
    ]),

    db.collection('sessions').createIndexes([
      { key: { tokenHash: 1 }, name: 'tokenHash_unique', unique: true },
      // TTL sweeper: expired sessions are removed by the server, so a stale cookie cannot be
      // resurrected even if someone later restores a database backup.
      { key: { expiresAt: 1 }, name: 'ttl_expiresAt', expireAfterSeconds: 0 },
      { key: { userId: 1, kind: 1 }, name: 'user_kind' },
      { key: { envelopeId: 1, recipientId: 1 }, name: 'envelope_recipient', sparse: true },
    ]),

    db.collection('envelopes').createIndexes([
      // Dashboard listing.
      { key: { ownerId: 1, updatedAt: -1 }, name: 'owner_recent' },
      // Signing link resolution. Multikey over the embedded recipients array, which keeps
      // token lookup to a single indexed read of a single document.
      { key: { 'recipients.tokenHash': 1 }, name: 'recipient_token', sparse: true },
      // Links issued before a reminder stay valid until expiry and are resolved through here.
      { key: { 'recipients.tokenHistory.hash': 1 }, name: 'recipient_token_history', sparse: true },
      { key: { versionGroupId: 1, version: -1 }, name: 'version_history' },
      // Maintenance sweeps.
      { key: { status: 1, expiresAt: 1 }, name: 'status_expiry' },
      { key: { status: 1, 'reminder.nextAt': 1 }, name: 'status_reminder' },
      // Public verification of a sealed file by its fingerprint.
      { key: { 'sealed.sha256': 1 }, name: 'sealed_fingerprint', sparse: true },
      { key: { 'sealed.manifestDigest': 1 }, name: 'sealed_manifest', sparse: true },
    ]),

    db.collection('auditEvents').createIndexes([
      { key: { envelopeId: 1, seq: 1 }, name: 'envelope_seq_unique', unique: true },
      { key: { versionGroupId: 1, at: 1 }, name: 'group_time' },
    ]),

    db.collection('emailLog').createIndexes([
      { key: { envelopeId: 1, createdAt: -1 }, name: 'envelope_recent' },
      { key: { status: 1, nextAttemptAt: 1 }, name: 'retry_queue' },
    ]),

    db.collection('rateLimits').createIndexes([
      { key: { expiresAt: 1 }, name: 'ttl_expiresAt', expireAfterSeconds: 0 },
    ]),
  ]);
}

/** Close the pool. Used by tests and by graceful shutdown, never by a request. */
export async function closeConnection(): Promise<void> {
  if (cache.client) {
    await cache.client.close();
    cache.client = null;
    cache.promise = null;
    cache.indexesReady = null;
  }
}
