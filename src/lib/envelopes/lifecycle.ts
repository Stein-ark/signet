import type { ObjectId } from 'mongodb';
import { recordEvent } from '@/lib/audit/chain';
import { completeIfAllSigned } from '@/lib/envelopes/completion';
import { reissueSigningLinks } from '@/lib/envelopes/links';
import { recipientsUpNext } from '@/lib/envelopes/routing';
import { envelopes, sessions } from '@/lib/models/types';

/** Automatic reminders stop after this many per recipient. Owners can still remind by hand. */
export const MAX_AUTOMATIC_REMINDERS = 5;
const BATCH_SIZE = 100;

type Context = { ip: string; userAgent: string };

/** End every open signing session on an envelope, so a closed agreement cannot be acted on. */
export async function revokeSigningSessions(envelopeId: ObjectId): Promise<void> {
  await (await sessions()).updateMany(
    { kind: 'signing', envelopeId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

/** Mark envelopes whose signing window has closed as expired. */
export async function expireOverdueEnvelopes(context: Context, now = new Date()): Promise<number> {
  const collection = await envelopes();
  const overdue = await collection
    .find({ status: 'sent', expiresAt: { $lte: now } }, { projection: { _id: 1, versionGroupId: 1, expiresAt: 1 } })
    .limit(BATCH_SIZE)
    .toArray();

  let expired = 0;
  for (const envelope of overdue) {
    const update = await collection.updateOne(
      { _id: envelope._id, status: 'sent', expiresAt: { $lte: now } },
      { $set: { status: 'expired', 'reminder.nextAt': null, updatedAt: now } },
    );
    if (update.modifiedCount !== 1) continue;
    expired += 1;
    await revokeSigningSessions(envelope._id);
    await recordEvent({
      envelopeId: envelope._id,
      versionGroupId: envelope.versionGroupId,
      type: 'envelope.expired',
      actorType: 'system',
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { expiresAt: envelope.expiresAt.toISOString() },
    });
  }
  return expired;
}

/**
 * Complete envelopes where everyone has signed but completion was never recorded, which happens
 * only if the process stopped between a final signature and the completion step.
 */
export async function completeStalledEnvelopes(context: Context): Promise<number> {
  const stalled = await (await envelopes())
    .find(
      {
        status: 'sent',
        'recipients.0': { $exists: true },
        recipients: { $not: { $elemMatch: { status: { $ne: 'signed' } } } },
      },
      { projection: { _id: 1, versionGroupId: 1 } },
    )
    .limit(BATCH_SIZE)
    .toArray();

  let completed = 0;
  for (const envelope of stalled) {
    if (await completeIfAllSigned(envelope, context)) completed += 1;
  }
  return completed;
}

/** Send the reminders that have come due. */
export async function sendDueReminders(
  context: Context,
  now = new Date(),
): Promise<{ envelopes: number; delivered: number; failed: number }> {
  const collection = await envelopes();
  const due = await collection
    .find({ status: 'sent', expiresAt: { $gt: now }, 'reminder.nextAt': { $ne: null, $lte: now } })
    .limit(BATCH_SIZE)
    .toArray();

  const totals = { envelopes: 0, delivered: 0, failed: 0 };
  for (const envelope of due) {
    const recipients = recipientsUpNext(envelope).filter(
      (recipient) => recipient.invitedAt && recipient.remindersSent < MAX_AUTOMATIC_REMINDERS,
    );
    const nextAt = recipients.length
      ? new Date(now.getTime() + envelope.reminder.intervalHours * 60 * 60 * 1000)
      : null;

    // Claim this round by moving nextAt on. Overlapping cron runs see the old value gone and skip
    // the envelope, so nobody receives the same reminder twice.
    const claim = await collection.updateOne(
      { _id: envelope._id, status: 'sent', 'reminder.nextAt': envelope.reminder.nextAt },
      { $set: { 'reminder.nextAt': nextAt } },
    );
    if (claim.modifiedCount !== 1 || !recipients.length) continue;

    try {
      const result = await reissueSigningLinks({
        envelope,
        recipientIds: recipients.map((recipient) => recipient.id),
        reason: 'reminder',
        actor: { type: 'system', id: null, email: null, name: null },
        context,
      });
      totals.envelopes += 1;
      totals.delivered += result.delivered.length;
      totals.failed += result.failures.length;
    } catch (error) {
      console.error(`[signet] automatic reminder failed envelope=${envelope._id.toHexString()}`, error);
    }
  }
  return totals;
}
