import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A complete, throwaway environment for every test file.
 *
 * Secrets are generated per run and storage goes to a fresh temporary directory, so tests never
 * touch a developer's .env.local, database or stored documents.
 */
const seal = generateKeyPairSync('ed25519');

Object.assign(process.env, {
  NODE_ENV: 'test',
  APP_URL: 'http://signet.test',
  MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:1/unused-by-unit-tests',
  MONGODB_DB: 'signet-test',
  APP_SECRET: randomBytes(32).toString('base64'),
  STORAGE_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: mkdtempSync(path.join(tmpdir(), 'signet-test-')),
  SEAL_PRIVATE_KEY: seal.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  SEAL_PUBLIC_KEY: seal.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  EMAIL_DRIVER: 'console',
  CRON_SECRET: randomBytes(24).toString('base64url'),
  TRUST_PROXY_HOPS: '1',
});
