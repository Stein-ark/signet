import { createHash } from 'node:crypto';
import { rateLimits } from '@/lib/models/types';
import { tooManyRequests } from '@/lib/util/errors';
import { UNKNOWN_IP } from '@/lib/util/http';

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Fixed window counter shared by every throttled endpoint.
 *
 * Each call counts as one attempt. Keys are hashed so that email addresses and IPs never sit in
 * the rate limit collection in the clear, and the TTL index removes a window once it has passed.
 */
export async function enforceRateLimit(
  scope: string,
  key: string,
  limit: number,
  windowMs = DEFAULT_WINDOW_MS,
): Promise<void> {
  const window = Math.floor(Date.now() / windowMs);
  const id = `${scope}:${createHash('sha256').update(key).digest('hex')}:${window}`;
  const result = await (await rateLimits()).findOneAndUpdate(
    { _id: id },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 1) * windowMs) } },
    { upsert: true, returnDocument: 'after' },
  );
  const count = result?.count;
  if (count !== undefined && count > limit) {
    const retryAfterSeconds = Math.ceil(((window + 1) * windowMs - Date.now()) / 1000);
    throw tooManyRequests('Too many attempts. Try again later.', retryAfterSeconds);
  }
}

/**
 * Per IP limit that is skipped when no trustworthy client address is known.
 *
 * Without a trusted proxy every caller shares the address "unknown", and limiting on it would
 * turn a per client limit into a global one that any single caller could exhaust for everyone.
 */
export async function enforceIpRateLimit(
  scope: string,
  ip: string,
  limit: number,
  windowMs = DEFAULT_WINDOW_MS,
): Promise<void> {
  if (ip === UNKNOWN_IP) return;
  await enforceRateLimit(`${scope}:ip`, ip, limit, windowMs);
}
