import { ObjectId } from 'mongodb';
import { requireOwner, assertCsrf } from '@/lib/auth/session';
import { recordEvent } from '@/lib/audit/chain';
import { recipientsInputSchema } from '@/lib/envelopes/validation';
import { envelopes, type RecipientDoc } from '@/lib/models/types';
import { conflict, notFound } from '@/lib/util/errors';
import { assertSameOrigin, ok, readJson, route, type RequestContext } from '@/lib/util/http';
import { newId } from '@/lib/util/crypto';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ id: string }> };

export const PUT = route(async (
  request: Request,
  context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  assertSameOrigin(request);
  const { session, user } = await requireOwner();
  assertCsrf(request, session);
  const { id } = await routeContext.params;
  if (!ObjectId.isValid(id)) throw notFound();
  const envelopeId = new ObjectId(id);
  const input = await readJson(request, recipientsInputSchema);

  const collection = await envelopes();
  const existing = await collection.findOne({ _id: envelopeId, ownerId: user._id, status: 'draft' });
  if (!existing) throw notFound();

  const previousByEmail = new Map(existing.recipients.map((recipient) => [recipient.email, recipient]));
  const recipients: RecipientDoc[] = input.recipients.map((recipient, index) => {
    const previous = previousByEmail.get(recipient.email);
    return previous
      ? {
          ...previous,
          name: recipient.name || recipient.email.split('@')[0] || recipient.email,
          routingOrder: index + 1,
        }
      : {
          id: newId(),
          email: recipient.email,
          name: recipient.name || recipient.email.split('@')[0] || recipient.email,
          routingOrder: index + 1,
          isOwner: false,
          status: 'pending',
          tokenHash: null,
          tokenIssuedAt: null,
          tokenExpiresAt: null,
          tokenHistory: [],
          otp: { hash: null, expiresAt: null, attempts: 0, sentAt: null, resendCount: 0, verifiedAt: null },
          consent: null,
          signatureKey: null,
          initialsKey: null,
          invitedAt: null,
          viewedAt: null,
          signedAt: null,
          declinedAt: null,
          declineReason: null,
          remindersSent: 0,
          lastReminderAt: null,
          lastIp: null,
          lastUserAgent: null,
        };
  });
  const validRecipientIds = new Set(recipients.map((recipient) => recipient.id));
  const retainedFields = existing.fields.filter((field) => validRecipientIds.has(field.recipientId));

  const result = await collection.updateOne(
    { _id: envelopeId, ownerId: user._id, status: 'draft', updatedAt: existing.updatedAt },
    { $set: { recipients, fields: retainedFields, updatedAt: new Date() } },
  );
  if (result.matchedCount !== 1) throw conflict('This draft changed. Reload it and try again.');

  await recordEvent({
    envelopeId,
    versionGroupId: existing.versionGroupId,
    type: 'envelope.recipients_updated',
    actorType: 'owner',
    actorId: user._id.toHexString(),
    actorEmail: user.email,
    actorName: user.name,
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { recipientCount: recipients.length, recipients: recipients.map(({ email }) => email) },
  });

  return ok({
    recipients: recipients.map(({ id: recipientId, name, email, routingOrder }) => ({
      id: recipientId,
      name,
      email,
      routingOrder,
    })),
  });
});
