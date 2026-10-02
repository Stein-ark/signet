import { recordEvent } from '@/lib/audit/chain';
import { logEmail } from '@/lib/email/log';
import { sendEmail } from '@/lib/email/send';
import { invitationEmail } from '@/lib/email/templates';
import { AWAITING_STATUSES } from '@/lib/envelopes/routing';
import { envelopes, type EnvelopeDoc } from '@/lib/models/types';
import { createSecretToken } from '@/lib/util/crypto';
import { conflict } from '@/lib/util/errors';

export type Actor = {
  type: 'owner' | 'system';
  id: string | null;
  email: string | null;
  name: string | null;
};

const MAX_TOKEN_HISTORY = 10;

/**
 * Mint fresh signing links for some recipients and email them.
 *
 * Only a hash of each link is stored, so delivering a link again always means minting a new
 * one. The previous link is kept in the recipient's token history until it expires, so an
 * earlier email keeps working.
 *
 * `reason` decides how the delivery is recorded:
 *   - `reminder` nudges recipients who were already invited and counts towards their reminders.
 *   - `turn` invites recipients for the first time when sequential routing reaches them. Only
 *     recipients not yet invited are claimed, which makes a concurrent double advance harmless.
 *
 * Each recipient is updated in place by array filter, so this never rewrites another
 * recipient's state and does not conflict with signers acting at the same moment.
 */
export async function reissueSigningLinks(input: {
  envelope: EnvelopeDoc;
  recipientIds: string[];
  reason: 'reminder' | 'turn';
  actor: Actor;
  context: { ip: string; userAgent: string };
  /** When given, also schedules the next automatic reminder. */
  nextReminderAt?: Date | null;
}): Promise<{ delivered: string[]; failures: string[] }> {
  const { envelope, reason, actor, context } = input;
  const targets = envelope.recipients.filter((recipient) => input.recipientIds.includes(recipient.id));
  if (!targets.length) return { delivered: [], failures: [] };

  const now = new Date();
  const tokens = new Map<string, { token: string; hash: string }>();
  const set: Record<string, unknown> = { updatedAt: now };
  const inc: Record<string, number> = {};
  const arrayFilters: Record<string, unknown>[] = [];

  targets.forEach((recipient, index) => {
    const slot = `r${index}`;
    const minted = createSecretToken('signing-link');
    tokens.set(recipient.id, minted);

    const history = [
      ...(recipient.tokenHistory ?? []).filter((previous) => previous.expiresAt > now),
      ...(recipient.tokenHash && recipient.tokenExpiresAt && recipient.tokenExpiresAt > now
        ? [{ hash: recipient.tokenHash, expiresAt: recipient.tokenExpiresAt }]
        : []),
    ].slice(-MAX_TOKEN_HISTORY);

    const path = `recipients.$[${slot}]`;
    set[`${path}.tokenHash`] = minted.hash;
    set[`${path}.tokenIssuedAt`] = now;
    set[`${path}.tokenExpiresAt`] = envelope.expiresAt;
    set[`${path}.tokenHistory`] = history;
    set[`${path}.otp.hash`] = null;
    set[`${path}.otp.expiresAt`] = null;
    set[`${path}.otp.attempts`] = 0;
    set[`${path}.otp.sentAt`] = null;
    if (reason === 'reminder') {
      set[`${path}.lastReminderAt`] = now;
      inc[`${path}.remindersSent`] = 1;
    } else {
      set[`${path}.invitedAt`] = now;
    }

    arrayFilters.push({
      [`${slot}.id`]: recipient.id,
      [`${slot}.status`]: { $in: AWAITING_STATUSES },
      ...(reason === 'turn' ? { [`${slot}.invitedAt`]: null } : {}),
    });
  });

  if (reason === 'reminder') inc['reminder.sentCount'] = targets.length;
  if (input.nextReminderAt !== undefined) set['reminder.nextAt'] = input.nextReminderAt;

  const collection = await envelopes();
  const update = await collection.updateOne(
    { _id: envelope._id, status: 'sent' },
    { $set: set, ...(Object.keys(inc).length ? { $inc: inc } : {}) },
    { arrayFilters },
  );
  if (update.matchedCount !== 1) throw conflict('This agreement changed. Reload and try again.');

  // A recipient may have signed, declined or been claimed by a concurrent advance between the
  // read and the update. Only links that actually landed are worth emailing.
  const fresh = await collection.findOne(
    { _id: envelope._id },
    { projection: { 'recipients.id': 1, 'recipients.tokenHash': 1, 'recipients.remindersSent': 1 } },
  );
  const landed = targets.filter((recipient) =>
    fresh?.recipients.some((item) => item.id === recipient.id && item.tokenHash === tokens.get(recipient.id)!.hash),
  );

  const delivered: string[] = [];
  const failures: string[] = [];
  const template = reason === 'reminder' ? 'reminder' : 'invitation';
  for (const recipient of landed) {
    const message = invitationEmail({
      to: recipient.email,
      ownerName: envelope.ownerName,
      title: envelope.title,
      token: tokens.get(recipient.id)!.token,
    });
    try {
      const result = await sendEmail(message);
      await logEmail({ message, envelopeId: envelope._id, template, result });
      await recordEvent({
        envelopeId: envelope._id,
        versionGroupId: envelope.versionGroupId,
        type: reason === 'reminder' ? 'envelope.reminder_sent' : 'recipient.invited',
        actorType: actor.type,
        actorId: actor.id,
        actorEmail: recipient.email,
        actorName: recipient.name,
        ip: context.ip,
        userAgent: context.userAgent,
        meta: {
          provider: result.provider,
          ...(reason === 'reminder'
            ? { remindersSent: fresh?.recipients.find((item) => item.id === recipient.id)?.remindersSent ?? null }
            : { routingOrder: recipient.routingOrder }),
          ...(actor.type === 'system' ? { automatic: true } : {}),
        },
      });
      delivered.push(recipient.email);
    } catch (error) {
      failures.push(recipient.email);
      try {
        await logEmail({ message, envelopeId: envelope._id, template, error });
      } catch (logError) {
        console.error('[signet] failed to record signing link delivery failure', logError);
      }
      console.error(
        `[signet] ${template} delivery failed envelope=${envelope._id.toHexString()} recipient=${recipient.email}`,
        error,
      );
    }
  }

  return { delivered, failures };
}
