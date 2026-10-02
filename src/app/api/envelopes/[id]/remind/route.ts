import { ObjectId } from 'mongodb';
import { assertCsrf, requireOwner } from '@/lib/auth/session';
import { reissueSigningLinks } from '@/lib/envelopes/links';
import { recipientsUpNext } from '@/lib/envelopes/routing';
import { envelopes } from '@/lib/models/types';
import { conflict, notFound } from '@/lib/util/errors';
import { assertSameOrigin, ok, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ id: string }> };

export const POST = route(async (
  request: Request,
  context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  assertSameOrigin(request);
  const { session, user } = await requireOwner();
  assertCsrf(request, session);
  const { id } = await routeContext.params;
  if (!ObjectId.isValid(id)) throw notFound();
  const envelope = await (await envelopes()).findOne({
    _id: new ObjectId(id),
    ownerId: user._id,
    status: 'sent',
  });
  if (!envelope) throw notFound();

  // Only recipients who can act now are reminded. In sequential routing a later signer's link
  // would only tell them to wait, so they hear from Signet when their turn arrives.
  const outstanding = recipientsUpNext(envelope);
  if (!outstanding.length) throw conflict('There are no recipients waiting to sign.');

  const { delivered, failures } = await reissueSigningLinks({
    envelope,
    recipientIds: outstanding.map((recipient) => recipient.id),
    reason: 'reminder',
    actor: { type: 'owner', id: user._id.toHexString(), email: user.email, name: user.name },
    context,
    nextReminderAt: new Date(Date.now() + envelope.reminder.intervalHours * 60 * 60 * 1000),
  });

  return ok({
    reminded: delivered.length,
    deliveryFailures: failures,
    ...(failures.length ? { warning: 'Some reminders could not be delivered. You can try again after checking email configuration.' } : {}),
  }, { status: failures.length ? 207 : 200 });
});
