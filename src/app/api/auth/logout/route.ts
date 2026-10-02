import { assertCsrf, destroyOwnerSession, readOwnerSession } from '@/lib/auth/session';
import { assertSameOrigin, noContent, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

export const POST = route(async (request: Request, _context: RequestContext): Promise<NextResponse> => {
  assertSameOrigin(request);
  const owner = await readOwnerSession();
  if (owner) assertCsrf(request, owner.session);
  await destroyOwnerSession();
  return noContent();
});
