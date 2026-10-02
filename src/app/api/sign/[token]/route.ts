import { recordEvent } from '@/lib/audit/chain';
import { envelopes } from '@/lib/models/types';
import { resolveSigningLink } from '@/lib/signing/resolve';
import { ok, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ token: string }> };
const LINK_OPEN_EVENT_INTERVAL_MS = 60 * 60 * 1000;

export const GET = route(async (
  _request: Request,
  context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  const { token } = await routeContext.params;
  const { envelope, recipient } = await resolveSigningLink(token);
  // Recorded at most once an hour per recipient. This endpoint needs no authentication beyond
  // the link, and mail scanners fetch links automatically, so an event per request would let
  // anyone holding a link pad the audit trail without limit.
  const now = new Date();
  const opened = await (await envelopes()).updateOne(
    {
      _id: envelope._id,
      recipients: {
        $elemMatch: {
          id: recipient.id,
          $or: [{ linkOpenedAt: null }, { linkOpenedAt: { $lte: new Date(now.getTime() - LINK_OPEN_EVENT_INTERVAL_MS) } }],
        },
      },
    },
    { $set: { 'recipients.$.linkOpenedAt': now } },
  );
  if (opened.modifiedCount === 1) {
    await recordEvent({
      envelopeId: envelope._id,
      versionGroupId: envelope.versionGroupId,
      type: 'recipient.link_opened',
      actorType: 'recipient',
      actorId: recipient.id,
      actorEmail: recipient.email,
      actorName: recipient.name,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }
  return ok({
    signingRequest: {
      title: envelope.title,
      ownerName: envelope.ownerName,
      recipientName: recipient.name,
      otpSent: Boolean(recipient.otp.sentAt && recipient.otp.expiresAt && recipient.otp.expiresAt > new Date()),
    },
  });
});
