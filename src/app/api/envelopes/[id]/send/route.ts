import { ObjectId } from 'mongodb';
import { assertCsrf, requireOwner } from '@/lib/auth/session';
import { recordEvent } from '@/lib/audit/chain';
import { logEmail } from '@/lib/email/log';
import { sendEmail } from '@/lib/email/send';
import { invitationEmail } from '@/lib/email/templates';
import { recipientsUpNext } from '@/lib/envelopes/routing';
import { envelopes } from '@/lib/models/types';
import { createSecretToken } from '@/lib/util/crypto';
import { assertSameOrigin, ok, route, type RequestContext } from '@/lib/util/http';
import { conflict, notFound } from '@/lib/util/errors';
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

  const collection = await envelopes();
  const envelopeId = new ObjectId(id);
  const envelope = await collection.findOne({
    _id: envelopeId,
    ownerId: user._id,
    status: 'draft',
  });
  if (!envelope) throw notFound();

  if (!envelope.recipients.length) throw conflict('Add at least one recipient before sending.');
  if (!envelope.fields.length) throw conflict('Place signing fields before sending.');
  for (const recipient of envelope.recipients) {
    if (!envelope.fields.some(
      (field) => field.recipientId === recipient.id && field.type === 'signature' && field.required,
    )) {
      throw conflict(`Add a required signature field for ${recipient.name || recipient.email}.`);
    }
  }
  if (envelope.fields.some((field) => field.required && field.value !== null && field.value.trim() === '')) {
    throw conflict('A required field is incomplete.');
  }
  if (envelope.expiresAt <= new Date()) throw conflict('This draft has expired. Create a new draft to send it.');

  const now = new Date();
  const tokens = new Map<string, string>();
  const minted = envelope.recipients.map((recipient) => {
    const { token, hash } = createSecretToken('signing-link');
    tokens.set(recipient.id, token);
    return {
      ...recipient,
      tokenHash: hash,
      tokenIssuedAt: now,
      tokenExpiresAt: envelope.expiresAt,
      tokenHistory: [],
      status: 'invited' as const,
    };
  });
  // In sequential routing only the first group is emailed now. Later groups are invited, with a
  // freshly minted link, when the group before them finishes signing.
  const firstGroup = new Set(
    recipientsUpNext({ signingOrder: envelope.signingOrder, recipients: minted }).map((recipient) => recipient.id),
  );
  const recipients = minted.map((recipient) => ({
    ...recipient,
    invitedAt: firstGroup.has(recipient.id) ? now : null,
  }));

  const updated = await collection.updateOne(
    { _id: envelopeId, ownerId: user._id, status: 'draft', updatedAt: envelope.updatedAt },
    { $set: { status: 'sent', recipients, sentAt: now, updatedAt: now, 'reminder.nextAt': new Date(now.getTime() + envelope.reminder.intervalHours * 60 * 60 * 1000) } },
  );
  if (updated.matchedCount !== 1) throw conflict('This draft changed. Reload it and try again.');

  await recordEvent({
    envelopeId,
    versionGroupId: envelope.versionGroupId,
    type: 'envelope.sent',
    actorType: 'owner',
    actorId: user._id.toHexString(),
    actorEmail: user.email,
    actorName: user.name,
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { recipientCount: recipients.length, signingOrder: envelope.signingOrder },
  });

  const deliveryFailures: string[] = [];
  for (const recipient of recipients.filter((item) => firstGroup.has(item.id))) {
    const message = invitationEmail({
      to: recipient.email,
      ownerName: envelope.ownerName,
      title: envelope.title,
      token: tokens.get(recipient.id)!,
    });
    try {
      const result = await sendEmail(message);
      await logEmail({ message, envelopeId, template: 'invitation', result });
      await recordEvent({
        envelopeId,
        versionGroupId: envelope.versionGroupId,
        type: 'recipient.invited',
        actorType: 'owner',
        actorId: user._id.toHexString(),
        actorEmail: recipient.email,
        actorName: recipient.name,
        ip: context.ip,
        userAgent: context.userAgent,
        meta: { provider: result.provider },
      });
    } catch (error) {
      deliveryFailures.push(recipient.email);
      try {
        await logEmail({ message, envelopeId, template: 'invitation', error });
      } catch (logError) {
        console.error('[signet] failed to record invitation delivery failure', logError);
      }
      console.error(`[signet] invitation delivery failed envelope=${envelopeId.toHexString()} recipient=${recipient.email}`, error);
    }
  }

  if (deliveryFailures.length) {
    return ok(
      {
        envelope: { id: envelopeId.toHexString(), status: 'sent' },
        deliveryFailures,
        warning: 'The agreement was sent, but some invitation emails could not be delivered. Contact the owner before retrying.',
      },
      { status: 207 },
    );
  }

  return ok({ envelope: { id: envelopeId.toHexString(), status: 'sent' }, delivered: firstGroup.size });
});
