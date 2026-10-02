import { createOwnerSession } from '@/lib/auth/session';
import { loginSchema } from '@/lib/auth/validation';
import { hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password';
import { users, type UserDoc } from '@/lib/models/types';
import { assertSameOrigin, ok, readJson, route, type RequestContext } from '@/lib/util/http';
import { unauthorized } from '@/lib/util/errors';
import { NextResponse } from 'next/server';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
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
  const collection = await users();
  const user = await collection.findOne({ email: input.email });

  if (!user) {
    await verifyPassword(input.password, DUMMY_PASSWORD_HASH);
    throw unauthorized(INVALID_CREDENTIALS);
  }

  const now = new Date();
  if (user.lockedUntil && user.lockedUntil > now) {
    throw unauthorized(INVALID_CREDENTIALS);
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    await collection.updateOne({ _id: user._id }, { $inc: { failedLoginCount: 1 } });
    const updatedUser = await collection.findOne({ _id: user._id }, { projection: { failedLoginCount: 1 } });
    if (updatedUser && updatedUser.failedLoginCount >= MAX_FAILED_LOGINS) {
      await collection.updateOne(
        { _id: user._id, failedLoginCount: { $gte: MAX_FAILED_LOGINS } },
        { $set: { lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000) } },
      );
    }
    throw unauthorized(INVALID_CREDENTIALS);
  }

  const reset = await collection.updateOne(
    {
      _id: user._id,
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
    },
    { $set: { failedLoginCount: 0, lockedUntil: null, updatedAt: now } },
  );
  if (reset.matchedCount !== 1) {
    throw unauthorized(INVALID_CREDENTIALS);
  }

  const currentUser = { ...user, failedLoginCount: 0, lockedUntil: null, updatedAt: now };
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
