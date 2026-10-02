import { assertCsrf } from '@/lib/auth/session';
import { recordEvent } from '@/lib/audit/chain';
import { requireSigningActor } from '@/lib/signing/session';
import { envelopes } from '@/lib/models/types';
import { conflict } from '@/lib/util/errors';
import { assertSameOrigin, ok, readJson, route, type RequestContext } from '@/lib/util/http';
import { z } from 'zod';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ token: string }> };
const declineSchema = z.object({ reason: z.string().trim().min(1).max(500) });

export const POST = route(async (
  request: Request,
  context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  assertSameOrigin(request);
  const { token } = await routeContext.params;
  const { envelope, recipient, session } = await requireSigningActor(token);
  assertCsrf(request, session);
  const { reason } = await readJson(request, declineSchema);
  const now = new Date();
  const recipients = envelope.recipients.map((item) =>
    item.id === recipient.id
      ? { ...item, status: 'declined' as const, declinedAt: now, declineReason: reason, lastIp: context.ip, lastUserAgent: context.userAgent }
      : item,
  );
  const update = await (await envelopes()).updateOne(
    {
      _id: envelope._id,
      status: 'sent',
      updatedAt: envelope.updatedAt,
      recipients: { $elemMatch: { id: recipient.id, status: { $in: ['invited', 'viewed', 'verified'] } } },
    },
    { $set: { recipients, status: 'declined', updatedAt: now } },
  );
  if (update.matchedCount !== 1) throw conflict('This signing request changed. Reload and try again.');

  await recordEvent({
    envelopeId: envelope._id,
    versionGroupId: envelope.versionGroupId,
    type: 'recipient.declined',
    actorType: 'recipient',
    actorId: recipient.id,
    actorEmail: recipient.email,
    actorName: recipient.name,
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { reason, declinedAt: now.toISOString() },
  });
  await recordEvent({
    envelopeId: envelope._id,
    versionGroupId: envelope.versionGroupId,
    type: 'envelope.declined',
    actorType: 'recipient',
    actorId: recipient.id,
    actorEmail: recipient.email,
    actorName: recipient.name,
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { reason },
  });
  return ok({ declined: true, declinedAt: now });
});
