import { createOwnerSession } from '@/lib/auth/session';
import { loginSchema } from '@/lib/auth/validation';
import { hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password';
import { users, type UserDoc } from '@/lib/models/types';
import { UNKNOWN_IP, assertSameOrigin, ok, readJson, route, type RequestContext } from '@/lib/util/http';
import { enforceIpRateLimit, enforceRateLimit } from '@/lib/util/rate-limit';
import { unauthorized } from '@/lib/util/errors';
import { NextResponse } from 'next/server';

/**
 * Sign in throttling.
 *
 * Attempts are limited per client IP, per email address from one IP, and per email address
 * overall. There is deliberately no account lockout: a lockout lets anyone who knows an owner's
 * address keep them out of their account, while the per email ceiling still caps distributed
 * guessing at a rate scrypt makes useless.
 */
const LOGIN_LIMIT_PER_IP = 30;
const LOGIN_LIMIT_PER_EMAIL_AND_IP = 10;
const LOGIN_LIMIT_PER_EMAIL = 50;
const INVALID_CREDENTIALS = 'Email or password is incorrect.';
const DUMMY_PASSWORD_HASH = [
  'scrypt',
  32768,
  8,
  1,
  Buffer.alloc(16).toString('base64'),
  Buffer.alloc(64).toString('base64'),
].join('$');

function publicUser(user: UserDoc) {
  return { id: user._id.toHexString(), name: user.name, email: user.email };
}

export const POST = route(async (request: Request, context: RequestContext): Promise<NextResponse> => {
  assertSameOrigin(request);
  const input = await readJson(request, loginSchema);
  await enforceIpRateLimit('login', context.ip, LOGIN_LIMIT_PER_IP);
  if (context.ip !== UNKNOWN_IP) {
    await enforceRateLimit('login:email-ip', `${input.email}|${context.ip}`, LOGIN_LIMIT_PER_EMAIL_AND_IP);
  }
  await enforceRateLimit('login:email', input.email, LOGIN_LIMIT_PER_EMAIL);

  const collection = await users();
  const user = await collection.findOne({ email: input.email });

  if (!user) {
    // Spend the same scrypt cost as a real check so response time does not reveal accounts.
    await verifyPassword(input.password, DUMMY_PASSWORD_HASH);
    throw unauthorized(INVALID_CREDENTIALS);
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    throw unauthorized(INVALID_CREDENTIALS);
  }

  const now = new Date();
  const currentUser = { ...user };
  if (needsRehash(user.passwordHash)) {
    currentUser.passwordHash = await hashPassword(input.password);
    await collection.updateOne(
      { _id: user._id },
      { $set: { passwordHash: currentUser.passwordHash, updatedAt: now } },
    );
  }

  await createOwnerSession(currentUser, context);
  return ok({ user: publicUser(currentUser) });
});
