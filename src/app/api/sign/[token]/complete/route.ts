import { assertCsrf } from '@/lib/auth/session';
import { recordEvent } from '@/lib/audit/chain';
import { storage, storageKey } from '@/lib/storage/index';
import { requireSigningActor } from '@/lib/signing/session';
import { envelopes, type ConsentRecord, type FieldDoc } from '@/lib/models/types';
import { conflict } from '@/lib/util/errors';
import { assertSameOrigin, ok, readJson, route, type RequestContext } from '@/lib/util/http';
import { z } from 'zod';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ token: string }> };
const inputSchema = z.object({
  adoptedName: z.string().trim().min(1).max(100),
  consent: z.literal(true),
  signaturePng: z.string().min(1).max(1_500_000),
  initialsPng: z.string().max(1_500_000).optional(),
});
const CONSENT_TEXT =
  'I have read this document, agree to sign it electronically, and intend my electronic signature to be legally binding.';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function decodePng(encoded: string): Buffer {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw conflict('The signature image is not a valid PNG.');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 4096 || height > 2048 || width * height > 4_000_000) {
    throw conflict('The signature image dimensions are too large.');
  }
  return bytes;
}

export const POST = route(async (
  request: Request,
  context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  assertSameOrigin(request);
  const { token } = await routeContext.params;
  const { envelope, recipient, session } = await requireSigningActor(token);
  assertCsrf(request, session);
  const input = await readJson(request, inputSchema);

  const signatureFields = envelope.fields.filter((field) => field.recipientId === recipient.id && field.type === 'signature');
  if (!signatureFields.length) throw conflict('This request does not have a signature field for you.');
  const signatureBytes = decodePng(input.signaturePng);
  const initialsFields = envelope.fields.filter((field) => field.recipientId === recipient.id && field.type === 'initials');
  const initialsBytes = input.initialsPng ? decodePng(input.initialsPng) : null;
  if (initialsFields.some((field) => field.required) && !initialsBytes) {
    throw conflict('Add your initials before completing this signature.');
  }

  const currentFields = envelope.fields.map((field) => {
    if (field.recipientId !== recipient.id) return field;
    if (field.type === 'signature') return { ...field, value: '__signature__', filledAt: new Date() };
    if (field.type === 'initials' && initialsBytes) return { ...field, value: '__initials__', filledAt: new Date() };
    if (field.type === 'date' && !field.value) return { ...field, value: new Date().toISOString().slice(0, 10), filledAt: new Date() };
    if (field.type === 'checkbox' && field.value === null) return { ...field, value: 'false', filledAt: new Date() };
    return field;
  });
  const missing = currentFields.find(
    (field) => field.recipientId === recipient.id && field.required &&
      (field.value === null || (field.value === '' && field.type !== 'checkbox')),
  );
  if (missing) throw conflict(`Complete the required ${missing.label || missing.type} field before signing.`);

  const signatureKey = storageKey('envelopes', envelope._id.toHexString(), 'signature', 'png');
  const initialsKey = initialsBytes
    ? storageKey('envelopes', envelope._id.toHexString(), 'initials', 'png')
    : null;
  await storage().put(signatureKey, signatureBytes, 'image/png');
  try {
    if (initialsKey && initialsBytes) await storage().put(initialsKey, initialsBytes, 'image/png');
  } catch (error) {
    await storage().remove(signatureKey);
    throw error;
  }

  const now = new Date();
  const consent: ConsentRecord = {
    agreedAt: now,
    text: CONSENT_TEXT,
    adoptedName: input.adoptedName,
    signatureType: 'drawn',
  };
  const recipients = envelope.recipients.map((item) =>
    item.id === recipient.id
      ? {
          ...item,
          status: 'signed' as const,
          consent,
          signatureKey,
          initialsKey,
          signedAt: now,
          lastIp: context.ip,
          lastUserAgent: context.userAgent,
        }
      : item,
  );
  const fields: FieldDoc[] = currentFields.map((field) => {
    if (field.recipientId !== recipient.id) return field;
    if (field.type === 'signature') return { ...field, value: signatureKey };
    if (field.type === 'initials' && initialsKey) return { ...field, value: initialsKey };
    return field;
  });
  const complete = recipients.every((item) => item.status === 'signed' || item.status === 'declined');
  const update = await (await envelopes()).updateOne(
    {
      _id: envelope._id,
      status: 'sent',
      updatedAt: envelope.updatedAt,
      recipients: { $elemMatch: { id: recipient.id, status: { $in: ['invited', 'viewed', 'verified'] } } },
    },
    {
      $set: {
        recipients,
        fields,
        updatedAt: now,
        ...(complete ? { status: 'completed', completedAt: now } : {}),
      },
    },
  );
  if (update.matchedCount !== 1) {
    await Promise.all([
      storage().remove(signatureKey),
      ...(initialsKey ? [storage().remove(initialsKey)] : []),
    ]);
    throw conflict('This signing request changed. Reload it before signing.');
  }

  await recordEvent({
    envelopeId: envelope._id,
    versionGroupId: envelope.versionGroupId,
    type: 'recipient.consented',
    actorType: 'recipient',
    actorId: recipient.id,
    actorEmail: recipient.email,
    actorName: input.adoptedName,
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { consentText: CONSENT_TEXT, signatureType: 'drawn' },
  });
  await recordEvent({
    envelopeId: envelope._id,
    versionGroupId: envelope.versionGroupId,
    type: 'recipient.signed',
    actorType: 'recipient',
    actorId: recipient.id,
    actorEmail: recipient.email,
    actorName: input.adoptedName,
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { signedAt: now.toISOString() },
  });
  if (complete) {
    await recordEvent({
      envelopeId: envelope._id,
      versionGroupId: envelope.versionGroupId,
      type: 'envelope.completed',
      actorType: 'system',
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { completedAt: now.toISOString() },
    });
  }

  return ok({ signed: true, envelopeCompleted: complete, signedAt: now });
});
