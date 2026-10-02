import { MongoServerError, ObjectId } from 'mongodb';
import { createOwnerSession } from '@/lib/auth/session';
import { registerSchema } from '@/lib/auth/validation';
import { hashPassword } from '@/lib/auth/password';
import { users, type UserDoc } from '@/lib/models/types';
import { assertSameOrigin, ok, readJson, route, type RequestContext } from '@/lib/util/http';
import { conflict } from '@/lib/util/errors';
import { enforceIpRateLimit } from '@/lib/util/rate-limit';
import { NextResponse } from 'next/server';

function publicUser(user: UserDoc) {
  return { id: user._id.toHexString(), name: user.name, email: user.email };
}

export const POST = route(async (request: Request, context: RequestContext): Promise<NextResponse> => {
  assertSameOrigin(request);
  await enforceIpRateLimit('register', context.ip, 10, 60 * 60 * 1000);
  const input = await readJson(request, registerSchema);
  const now = new Date();
  const user: UserDoc = {
    _id: new ObjectId(),
    name: input.name,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    createdAt: now,
    updatedAt: now,
  };

  try {
    await (await users()).insertOne(user);
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      throw conflict('An account with that email address already exists.');
    }
    throw error;
  }

  await createOwnerSession(user, context);
  return ok({ user: publicUser(user) }, { status: 201 });
});
