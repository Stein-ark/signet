import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(projectRoot, '.env.local');

try {
  writeFileSync(envPath, '', { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('.env.local already exists. Move it aside before generating a new environment.');
    process.exitCode = 1;
  } else {
    throw error;
  }
}

if (process.exitCode === 1) {
  process.exit();
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { format: 'der', type: 'pkcs8' },
  publicKeyEncoding: { format: 'der', type: 'spki' },
});

const values = {
  NODE_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  APP_NAME: 'Signet',
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  MONGODB_DB: 'signet',
  APP_SECRET: randomBytes(32).toString('base64'),
  STORAGE_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_DIR: '.storage',
  SEAL_PRIVATE_KEY: privateKey.toString('base64'),
  SEAL_PUBLIC_KEY: publicKey.toString('base64'),
  EMAIL_DRIVER: 'console',
  EMAIL_FROM: 'Signet <no-reply@localhost>',
  CRON_SECRET: randomBytes(32).toString('base64url'),
};

const contents = [
  '# Local development secrets. Do not commit or share this file.',
  ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
  '',
].join('\n');

try {
  writeFileSync(envPath, contents, { flag: 'w', mode: 0o600 });
} catch (error) {
  throw new Error(`Could not write ${envPath}.`, { cause: error });
}

console.log('Created .env.local with fresh development secrets.');
console.log('Start MongoDB before using database-backed features.');
