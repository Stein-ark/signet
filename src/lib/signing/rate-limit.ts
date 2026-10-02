import { rateLimits } from '@/lib/models/types';
import { tooManyRequests } from '@/lib/util/errors';
import { createHash } from 'node:crypto';

export async function enforceOtpRateLimit(scope: 'send' | 'verify', key: string, limit: number): Promise<void> {
  const now = new Date();
  const windowMs = 15 * 60 * 1000;
  const window = Math.floor(now.getTime() / windowMs);
  const id = `${scope}:${createHash('sha256').update(key).digest('hex')}:${window}`;
  const collection = await rateLimits();
  const result = await collection.findOneAndUpdate(
    { _id: id },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 1) * windowMs) } },
    { upsert: true, returnDocument: 'after' },
  );
  const count = result?.count;
  if (count !== undefined && count > limit) throw tooManyRequests('Too many attempts. Try again later.', 900);
}
