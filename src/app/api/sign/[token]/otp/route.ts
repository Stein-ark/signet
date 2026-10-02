import { assertSameOrigin, ok, readJson, route, type RequestContext } from '@/lib/util/http';
import { z } from 'zod';
import { env } from '@/lib/env';
import { recordEvent } from '@/lib/audit/chain';
import { logEmail } from '@/lib/email/log';
import { sendEmail } from '@/lib/email/send';
import type { EmailResult } from '@/lib/email/send';
import { otpEmail } from '@/lib/email/templates';
import { envelopes } from '@/lib/models/types';
import { resolveSigningLink } from '@/lib/signing/resolve';
import { enforceIpRateLimit, enforceRateLimit } from '@/lib/util/rate-limit';
import { createOtp, hashSecret, safeEqual } from '@/lib/util/crypto';
import { AppError, conflict } from '@/lib/util/errors';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ token: string }> };
const verifySchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const POST = route(async (
  request: Request,
  context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  assertSameOrigin(request);
  const { token } = await routeContext.params;
  const { envelope, recipient } = await resolveSigningLink(token);
  await enforceRateLimit('otp-send:recipient', recipient.id, 3);
  await enforceIpRateLimit('otp-send', context.ip, 20);

  const now = new Date();
  const otp = createOtp();
  const otpHash = hashSecret(otp, 'otp');
  const expiresAt = new Date(now.getTime() + env().OTP_TTL_MINUTES * 60_000);
  const update = await (await envelopes()).updateOne(
    {
      _id: envelope._id,
      status: 'sent',
      recipients: { $elemMatch: { id: recipient.id, tokenHash: recipient.tokenHash } },
    },
    {
      $set: {
        'recipients.$.otp.hash': otpHash,
        'recipients.$.otp.expiresAt': expiresAt,
        'recipients.$.otp.attempts': 0,
        'recipients.$.otp.sentAt': now,
        'recipients.$.otp.verifiedAt': null,
      },
      $inc: { 'recipients.$.otp.resendCount': 1 },
    },
  );
  if (update.matchedCount !== 1) throw conflict('This signing request changed. Reload the link and try again.');

  const message = otpEmail({ to: recipient.email, title: envelope.title, code: otp });
  let delivery: EmailResult;
  try {
    delivery = await sendEmail(message);
  } catch (error) {
    await (await envelopes()).updateOne(
      {
        _id: envelope._id,
        recipients: { $elemMatch: { id: recipient.id, 'otp.hash': otpHash } },
      },
      {
        $set: {
          'recipients.$.otp.hash': null,
          'recipients.$.otp.expiresAt': null,
          'recipients.$.otp.sentAt': null,
        },
      },
    );
    try {
      await logEmail({ message, envelopeId: envelope._id, template: 'otp', error });
    } catch (logError) {
      console.error('[signet] failed to record verification email failure', logError);
    }
    throw error;
  }
  await logEmail({ message, envelopeId: envelope._id, template: 'otp', result: delivery });

  await recordEvent({
    envelopeId: envelope._id,
    versionGroupId: envelope.versionGroupId,
    type: 'recipient.otp_sent',
    actorType: 'recipient',
    actorId: recipient.id,
    actorEmail: recipient.email,
    actorName: recipient.name,
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { expiresAt: expiresAt.toISOString() },
  });
  return ok({ sent: true, expiresAt });
});

export const PUT = route(async (
  request: Request,
  context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  assertSameOrigin(request);
  const { token } = await routeContext.params;
  const { envelope, recipient } = await resolveSigningLink(token);
  await enforceRateLimit('otp-verify:recipient', recipient.id, 10);
  await enforceIpRateLimit('otp-verify', context.ip, 30);
  const { code } = await readJson(request, verifySchema);

  const now = new Date();
  const current = await (await envelopes()).findOne(
    { _id: envelope._id, 'recipients.id': recipient.id },
    { projection: { recipients: { $elemMatch: { id: recipient.id } } } },
  );
  const currentRecipient = current?.recipients[0];
  if (
    !currentRecipient?.otp.hash ||
    !currentRecipient.otp.expiresAt ||
    currentRecipient.otp.expiresAt <= now ||
    currentRecipient.otp.attempts >= env().OTP_MAX_ATTEMPTS
  ) {
    throw new AppError(400, 'otp_expired', 'That code has expired. Request a new one.');
  }

  const submittedHash = hashSecret(code, 'otp');
  if (!safeEqual(submittedHash, currentRecipient.otp.hash)) {
    await (await envelopes()).updateOne(
      {
        _id: envelope._id,
        recipients: {
          $elemMatch: {
            id: recipient.id,
            'otp.hash': currentRecipient.otp.hash,
            'otp.attempts': { $lt: env().OTP_MAX_ATTEMPTS },
          },
        },
      },
      { $inc: { 'recipients.$.otp.attempts': 1 } },
    );
    await recordEvent({
      envelopeId: envelope._id,
      versionGroupId: envelope.versionGroupId,
      type: 'recipient.otp_failed',
      actorType: 'recipient',
      actorId: recipient.id,
      actorEmail: recipient.email,
      actorName: recipient.name,
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { reason: 'incorrect_code' },
    });
    throw new AppError(400, 'otp_invalid', 'That code is not correct.');
  }

  const consumed = await (await envelopes()).updateOne(
    {
      _id: envelope._id,
      status: 'sent',
      recipients: {
        $elemMatch: {
          id: recipient.id,
          tokenHash: recipient.tokenHash,
          'otp.hash': currentRecipient.otp.hash,
          'otp.expiresAt': { $gt: now },
          'otp.attempts': { $lt: env().OTP_MAX_ATTEMPTS },
          status: { $in: ['invited', 'viewed', 'verified'] },
        },
      },
    },
    {
      $set: {
        'recipients.$.otp.hash': null,
        'recipients.$.otp.expiresAt': null,
        'recipients.$.otp.verifiedAt': now,
        'recipients.$.status': 'verified',
      },
    },
  );
  if (consumed.matchedCount !== 1) {
    throw new AppError(400, 'otp_expired', 'That code has expired. Request a new one.');
  }

  const { createSigningSession } = await import('@/lib/auth/session');
  await createSigningSession(envelope._id, recipient.id, context);
  await recordEvent({
    envelopeId: envelope._id,
    versionGroupId: envelope.versionGroupId,
    type: 'recipient.otp_verified',
    actorType: 'recipient',
    actorId: recipient.id,
    actorEmail: recipient.email,
    actorName: recipient.name,
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { verifiedAt: now.toISOString() },
  });
  return ok({ verified: true });
});
