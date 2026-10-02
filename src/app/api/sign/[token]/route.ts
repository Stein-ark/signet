import { recordEvent } from '@/lib/audit/chain';
import { resolveSigningLink } from '@/lib/signing/resolve';
import { ok, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ token: string }> };

export const GET = route(async (
  _request: Request,
  context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  const { token } = await routeContext.params;
  const { envelope, recipient } = await resolveSigningLink(token);
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
  return ok({
    signingRequest: {
      title: envelope.title,
      ownerName: envelope.ownerName,
      recipientName: recipient.name,
      otpSent: Boolean(recipient.otp.sentAt && recipient.otp.expiresAt && recipient.otp.expiresAt > new Date()),
    },
  });
});
