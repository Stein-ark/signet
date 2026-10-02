import { ObjectId } from 'mongodb';
import { requireOwner } from '@/lib/auth/session';
import { readChain, verifyChain } from '@/lib/audit/chain';
import { envelopes } from '@/lib/models/types';
import { notFound } from '@/lib/util/errors';
import { ok, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ id: string }> };

export const GET = route(async (
  _request: Request,
  _context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  const { user } = await requireOwner();
  const { id } = await routeContext.params;
  if (!ObjectId.isValid(id)) throw notFound();
  const envelope = await (await envelopes()).findOne(
    { _id: new ObjectId(id), ownerId: user._id },
    { projection: { _id: 1 } },
  );
  if (!envelope) throw notFound();

  const events = await readChain(envelope._id);
  const verification = verifyChain(events);
  return ok({
    verification,
    events: events.map((event) => ({
      seq: event.seq,
      type: event.type,
      actorType: event.actorType,
      actorName: event.actorName,
      actorEmail: event.actorEmail,
      at: event.at,
      ip: event.ip,
      meta: event.meta,
      hash: event.hash,
    })),
  });
});
