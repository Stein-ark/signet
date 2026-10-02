import { requireSigningActor } from '@/lib/signing/session';
import { envelopes } from '@/lib/models/types';
import { recordEvent } from '@/lib/audit/chain';
import { ok, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ token: string }> };

export const GET = route(async (
  _request: Request,
  _context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  const { token } = await routeContext.params;
  const { envelope, recipient, session } = await requireSigningActor(token);
  if (recipient.status === 'verified') {
    const viewedAt = new Date();
    const update = await (await envelopes()).updateOne(
      { _id: envelope._id, recipients: { $elemMatch: { id: recipient.id, status: 'verified' } } },
      { $set: { 'recipients.$.status': 'viewed', 'recipients.$.viewedAt': viewedAt, updatedAt: viewedAt } },
    );
    if (update.matchedCount === 1) {
      await recordEvent({
        envelopeId: envelope._id,
        versionGroupId: envelope.versionGroupId,
        type: 'recipient.document_viewed',
        actorType: 'recipient',
        actorId: recipient.id,
        actorEmail: recipient.email,
        actorName: recipient.name,
        ip: session.ip,
        userAgent: session.userAgent,
      });
    }
  }
  return ok({
    signing: {
      title: envelope.title,
      ownerName: envelope.ownerName,
      recipient: { id: recipient.id, name: recipient.name, email: recipient.email },
      csrfToken: session.csrfToken,
      consentText:
        'I have read this document, agree to sign it electronically, and intend my electronic signature to be legally binding.',
      document: {
        filename: envelope.document.filename,
        pageCount: envelope.document.pageCount,
        pages: envelope.document.pages,
      },
      fields: envelope.fields
        .filter((field) => field.recipientId === recipient.id)
        .map(({ id, page, type, nx, ny, nw, nh, required, label, fontSize, maxLength, value }) => ({
          id,
          page,
          type,
          nx,
          ny,
          nw,
          nh,
          required,
          label,
          fontSize,
          maxLength,
          value,
        })),
    },
  });
});
