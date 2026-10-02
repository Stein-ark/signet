import { ObjectId } from 'mongodb';
import { assertCsrf, requireOwner } from '@/lib/auth/session';
import { recordEvent } from '@/lib/audit/chain';
import { logEmail } from '@/lib/email/log';
import { sendEmail } from '@/lib/email/send';
import { invitationEmail } from '@/lib/email/templates';
import { envelopes } from '@/lib/models/types';
import { createSecretToken } from '@/lib/util/crypto';
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
  const envelopeId = new ObjectId(id);
  const collection = await envelopes();
  const envelope = await collection.findOne({
    _id: envelopeId,
    ownerId: user._id,
    status: 'sent',
  });
  if (!envelope) throw notFound();
  const outstanding = envelope.recipients.filter(
    (recipient) => recipient.status !== 'signed' && recipient.status !== 'declined',
  );
  if (!outstanding.length) throw conflict('There are no recipients waiting to sign.');

  const tokenByRecipient = new Map<string, string>();
  const now = new Date();
  const recipients = envelope.recipients.map((recipient) => {
    if (recipient.status === 'signed' || recipient.status === 'declined') return recipient;
    const { token, hash } = createSecretToken('signing-link');
    tokenByRecipient.set(recipient.id, token);
    return {
      ...recipient,
      tokenHistory: [
        ...(recipient.tokenHistory ?? []).filter((previous) => previous.expiresAt > now),
        ...(recipient.tokenHash && recipient.tokenExpiresAt && recipient.tokenExpiresAt > now
          ? [{ hash: recipient.tokenHash, expiresAt: recipient.tokenExpiresAt }]
          : []),
      ].slice(-10),
      tokenHash: hash,
      tokenIssuedAt: now,
      tokenExpiresAt: envelope.expiresAt,
      otp: { ...recipient.otp, hash: null, expiresAt: null, attempts: 0, sentAt: null },
      remindersSent: recipient.remindersSent + 1,
      lastReminderAt: now,
    };
  });
  const update = await collection.updateOne(
    { _id: envelopeId, ownerId: user._id, status: 'sent', updatedAt: envelope.updatedAt },
    {
      $set: {
        recipients,
        updatedAt: now,
        'reminder.nextAt': new Date(now.getTime() + envelope.reminder.intervalHours * 60 * 60 * 1000),
        'reminder.sentCount': envelope.reminder.sentCount + outstanding.length,
      },
    },
  );
  if (update.matchedCount !== 1) throw conflict('This agreement changed. Reload and try again.');

  const failures: string[] = [];
  for (const recipient of recipients) {
    const token = tokenByRecipient.get(recipient.id);
    if (!token) continue;
    const message = invitationEmail({
      to: recipient.email,
      ownerName: envelope.ownerName,
      title: envelope.title,
      token,
    });
    try {
      const result = await sendEmail(message);
      await logEmail({ message, envelopeId, template: 'reminder', result });
      await recordEvent({
        envelopeId,
        versionGroupId: envelope.versionGroupId,
        type: 'envelope.reminder_sent',
        actorType: 'owner',
        actorId: user._id.toHexString(),
        actorEmail: recipient.email,
        actorName: recipient.name,
        ip: context.ip,
        userAgent: context.userAgent,
        meta: { provider: result.provider, remindersSent: recipient.remindersSent },
      });
    } catch (error) {
      failures.push(recipient.email);
      try {
        await logEmail({ message, envelopeId, template: 'reminder', error });
      } catch (logError) {
        console.error('[signet] failed to record reminder delivery failure', logError);
      }
      console.error(`[signet] reminder delivery failed envelope=${envelopeId.toHexString()} recipient=${recipient.email}`, error);
    }
  }

  return ok({
    reminded: outstanding.length - failures.length,
    deliveryFailures: failures,
    ...(failures.length ? { warning: 'Some reminders could not be delivered. You can try again after checking email configuration.' } : {}),
  }, { status: failures.length ? 207 : 200 });
});
