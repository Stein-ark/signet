import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { assertCsrf, requireOwner } from '@/lib/auth/session';
import { recordEvent } from '@/lib/audit/chain';
import { logEmail } from '@/lib/email/log';
import { sendEmail } from '@/lib/email/send';
import { voidedEmail } from '@/lib/email/templates';
import { revokeSigningSessions } from '@/lib/envelopes/lifecycle';
import { isAwaiting } from '@/lib/envelopes/routing';
import { envelopes } from '@/lib/models/types';
import { conflict, notFound } from '@/lib/util/errors';
import { assertSameOrigin, ok, readJson, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ id: string }> };
const voidSchema = z.object({ reason: z.string().trim().min(1).max(500) });

/**
 * Cancel an agreement that is out for signature.
 *
 * Voiding is final: every signing link stops resolving because the envelope is no longer
 * "sent", open signing sessions are revoked, and recipients who were waiting are told they no
 * longer need to act. Signatures already collected stay in the record and the audit trail.
 */
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
  const { reason } = await readJson(request, voidSchema);

  const envelopeId = new ObjectId(id);
  const collection = await envelopes();
  const envelope = await collection.findOne({ _id: envelopeId, ownerId: user._id });
  if (!envelope) throw notFound();
  if (envelope.status !== 'sent') throw conflict('Only an agreement that is out for signature can be cancelled.');

  const now = new Date();
  const update = await collection.updateOne(
    { _id: envelopeId, ownerId: user._id, status: 'sent' },
    { $set: { status: 'voided', voidedAt: now, voidReason: reason, 'reminder.nextAt': null, updatedAt: now } },
  );
  if (update.matchedCount !== 1) throw conflict('This agreement changed. Reload and try again.');

  await revokeSigningSessions(envelopeId);
  await recordEvent({
    envelopeId,
    versionGroupId: envelope.versionGroupId,
    type: 'envelope.voided',
    actorType: 'owner',
    actorId: user._id.toHexString(),
    actorEmail: user.email,
    actorName: user.name,
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { reason, voidedAt: now.toISOString() },
  });

  // Only people who were actually sent a link are told about the cancellation.
  const notify = envelope.recipients.filter((recipient) => isAwaiting(recipient) && recipient.invitedAt);
  const failures: string[] = [];
  for (const recipient of notify) {
    const message = voidedEmail({ to: recipient.email, ownerName: envelope.ownerName, title: envelope.title, reason });
    try {
      const result = await sendEmail(message);
      await logEmail({ message, envelopeId, template: 'voided', result });
    } catch (error) {
      failures.push(recipient.email);
      try {
        await logEmail({ message, envelopeId, template: 'voided', error });
      } catch (logError) {
        console.error('[signet] failed to record cancellation delivery failure', logError);
      }
    }
  }

  return ok({
    envelope: { id, status: 'voided' },
    notified: notify.length - failures.length,
    deliveryFailures: failures,
  });
});
