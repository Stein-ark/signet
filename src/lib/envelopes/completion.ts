import { recordEvent } from '@/lib/audit/chain';
import { reissueSigningLinks } from '@/lib/envelopes/links';
import { recipientsUpNext } from '@/lib/envelopes/routing';
import { envelopes, type EnvelopeDoc } from '@/lib/models/types';

type Context = { ip: string; userAgent: string };

/**
 * Move an envelope to completed once every recipient has signed.
 *
 * This is a single conditional update rather than a decision made from a snapshot. When two
 * recipients of a parallel envelope sign at the same moment, each sees the other as unsigned in
 * its own snapshot; the condition below is evaluated by the database against the current
 * document, so whichever finishes last completes the envelope, and exactly one caller records
 * the event.
 */
export async function completeIfAllSigned(
  envelope: Pick<EnvelopeDoc, '_id' | 'versionGroupId'>,
  context: Context,
): Promise<boolean> {
  const now = new Date();
  const result = await (await envelopes()).updateOne(
    {
      _id: envelope._id,
      status: 'sent',
      'recipients.0': { $exists: true },
      recipients: { $not: { $elemMatch: { status: { $ne: 'signed' } } } },
    },
    { $set: { status: 'completed', completedAt: now, updatedAt: now, 'reminder.nextAt': null } },
  );
  if (result.modifiedCount !== 1) return false;

  await recordEvent({
    envelopeId: envelope._id,
    versionGroupId: envelope.versionGroupId,
    type: 'envelope.completed',
    actorType: 'system',
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { completedAt: now.toISOString() },
  });
  return true;
}

/**
 * In sequential routing, invite the recipients whose turn has just arrived.
 *
 * Delivery problems are logged rather than thrown: the signature that triggered the advance has
 * already been recorded, and the recipient can still be reached with a reminder.
 */
export async function inviteNextRecipients(envelopeId: EnvelopeDoc['_id'], context: Context): Promise<void> {
  const envelope = await (await envelopes()).findOne({ _id: envelopeId, status: 'sent' });
  if (!envelope || envelope.signingOrder !== 'sequential') return;

  const due = recipientsUpNext(envelope).filter((recipient) => !recipient.invitedAt);
  if (!due.length) return;

  try {
    await reissueSigningLinks({
      envelope,
      recipientIds: due.map((recipient) => recipient.id),
      reason: 'turn',
      actor: { type: 'system', id: null, email: null, name: null },
      context,
    });
  } catch (error) {
    console.error(`[signet] could not invite next signers envelope=${envelopeId.toHexString()}`, error);
  }
}
