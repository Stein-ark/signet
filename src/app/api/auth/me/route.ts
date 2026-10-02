import { readOwnerSession } from '@/lib/auth/session';
import { ok, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

export const GET = route(async (_request: Request, _context: RequestContext): Promise<NextResponse> => {
  const owner = await readOwnerSession();
  if (!owner) return ok({ user: null });
  return ok({
    user: {
      id: owner.user._id.toHexString(),
      name: owner.user.name,
      email: owner.user.email,
    },
  });
});
