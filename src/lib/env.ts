import { z } from 'zod';

/**
 * Centralised, validated environment configuration.
 *
 * Every secret in Signet lives here and nowhere else. The schema is validated once, lazily, on
 * first access from a server context. Validating up front means a misconfigured deployment
 * fails loudly at the first request instead of silently signing documents with a missing seal
 * key or writing unencrypted blobs to disk.
 *
 * This module must never be imported from a client component.
 */

const base64Key = (bytes: number, label: string) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          return Buffer.from(value, 'base64').length === bytes;
        } catch {
          return false;
        }
      },
      { message: `${label} must be ${bytes} bytes encoded as base64` },
    );

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    /** Absolute public origin, used to build signing links that land in people's inboxes. */
    APP_URL: z.url(),
    APP_NAME: z.string().min(1).default('Signet'),

    MONGODB_URI: z.string().min(1),
    MONGODB_DB: z.string().min(1).default('signet'),

    /**
     * Root secret used as an HMAC pepper for anything we index by hash (session tokens,
     * signing tokens, one time passcodes). Peppering means a leaked database dump alone does
     * not let an attacker brute force a six digit passcode offline.
     */
    APP_SECRET: base64Key(32, 'APP_SECRET'),

    /** AES-256-GCM master key that wraps every per object data key in storage. */
    STORAGE_ENCRYPTION_KEY: base64Key(32, 'STORAGE_ENCRYPTION_KEY'),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('.storage'),

    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default('auto'),
    S3_ENDPOINT: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: booleanish.default(true),

    /**
     * Ed25519 key pair used to sign the seal manifest of a finished document. Private key is
     * a base64 encoded PKCS#8 DER, public key a base64 encoded SPKI DER.
     */
    SEAL_PRIVATE_KEY: z.string().min(1),
    SEAL_PUBLIC_KEY: z.string().min(1),

    EMAIL_DRIVER: z.enum(['console', 'smtp', 'resend']).default('console'),
    EMAIL_FROM: z.string().min(1).default('Signet <no-reply@localhost>'),
    EMAIL_REPLY_TO: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_SECURE: booleanish.default(false),

    /** Bearer secret for the maintenance endpoint that expires envelopes and sends reminders. */
    CRON_SECRET: z.string().min(16),

    /**
     * Number of reverse proxies in front of the app that append to X-Forwarded-For. The client
     * address is read that many entries from the right, because everything further left was
     * supplied by the client and can be forged. 0 ignores forwarding headers entirely.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
    SIGNING_SESSION_MINUTES: z.coerce.number().int().positive().default(45),
    OWNER_SESSION_DAYS: z.coerce.number().int().positive().default(7),
    OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  })
  .superRefine((value, ctx) => {
    if (value.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when STORAGE_DRIVER is "s3"`,
          });
        }
      }
    }
    if (value.EMAIL_DRIVER === 'resend' && !value.RESEND_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'RESEND_API_KEY is required when EMAIL_DRIVER is "resend"',
      });
    }
    if (value.EMAIL_DRIVER === 'smtp' && !value.SMTP_HOST) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message: 'SMTP_HOST is required when EMAIL_DRIVER is "smtp"',
      });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Parse and cache the environment. Throws a single readable error listing every problem so a
 * deployment does not have to be fixed one variable at a time.
 */
export function env(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Signet is misconfigured. Fix these environment variables:\n${details}`);
  }

  cached = parsed.data;
  return cached;
}

/** True when cookies should carry the Secure attribute (any https origin). */
export function isSecureOrigin(): boolean {
  return env().APP_URL.startsWith('https://');
}

/** Reset the cache. Only used by tests that swap the environment between cases. */
export function resetEnvCache(): void {
  cached = null;
}
