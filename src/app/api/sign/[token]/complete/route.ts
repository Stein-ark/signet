import { PDFDocument } from '@cantoo/pdf-lib';
import { assertCsrf } from '@/lib/auth/session';
import { recordEvent } from '@/lib/audit/chain';
import { completeIfAllSigned, inviteNextRecipients } from '@/lib/envelopes/completion';
import { AWAITING_STATUSES } from '@/lib/envelopes/routing';
import { storage, storageKey } from '@/lib/storage/index';
import { requireSigningActor } from '@/lib/signing/session';
import { envelopes, type ConsentRecord } from '@/lib/models/types';
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

/**
 * Decode and fully validate a signature image.
 *
 * The header check rejects obvious junk cheaply. The image is then embedded into a scratch PDF
 * with the same library the sealing pipeline uses, so a PNG that would only fail at approval
 * time, after every other signer has finished, is rejected now while the signer can redraw it.
 */
async function decodePng(encoded: string): Promise<Buffer> {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw conflict('The signature image is not a valid PNG.');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 4096 || height > 2048 || width * height > 4_000_000) {
    throw conflict('The signature image dimensions are too large.');
  }
  try {
    await (await PDFDocument.create()).embedPng(bytes);
  } catch {
    throw conflict('The signature image could not be read. Clear it and draw it again.');
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

  const ownFields = envelope.fields.filter((field) => field.recipientId === recipient.id);
  if (!ownFields.some((field) => field.type === 'signature')) {
    throw conflict('This request does not have a signature field for you.');
  }
  const signatureBytes = await decodePng(input.signaturePng);
  const initialsBytes = input.initialsPng ? await decodePng(input.initialsPng) : null;
  if (ownFields.some((field) => field.type === 'initials' && field.required) && !initialsBytes) {
    throw conflict('Add your initials before completing this signature.');
  }

  // Signature, initials, blank dates and unticked checkboxes are filled by this request, so
  // only the remaining types can be missing.
  const missing = ownFields.find(
    (field) => field.required && field.type === 'text' && (field.value === null || field.value === ''),
  );
  if (missing) throw conflict(`Complete the required ${missing.label || missing.type} field before signing.`);

  const hasInitials = ownFields.some((field) => field.type === 'initials');
  const signatureKey = storageKey('envelopes', envelope._id.toHexString(), 'signature', 'png');
  const initialsKey = initialsBytes && hasInitials
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

  // Every path below names this recipient explicitly, so the update cannot touch another
  // recipient's state and needs no whole document version check. That is what lets several
  // recipients of a parallel envelope sign at once without conflicting.
  const set: Record<string, unknown> = {
    'recipients.$[me].status': 'signed',
    'recipients.$[me].consent': consent,
    'recipients.$[me].signatureKey': signatureKey,
    'recipients.$[me].initialsKey': initialsKey,
    'recipients.$[me].signedAt': now,
    'recipients.$[me].lastIp': context.ip,
    'recipients.$[me].lastUserAgent': context.userAgent,
    'fields.$[signature].value': signatureKey,
    'fields.$[signature].filledAt': now,
    'fields.$[blankDate].value': now.toISOString().slice(0, 10),
    'fields.$[blankDate].filledAt': now,
    'fields.$[blankCheckbox].value': 'false',
    'fields.$[blankCheckbox].filledAt': now,
    updatedAt: now,
  };
  const arrayFilters: Record<string, unknown>[] = [
    { 'me.id': recipient.id },
    { 'signature.recipientId': recipient.id, 'signature.type': 'signature' },
    { 'blankDate.recipientId': recipient.id, 'blankDate.type': 'date', 'blankDate.value': { $in: [null, ''] } },
    { 'blankCheckbox.recipientId': recipient.id, 'blankCheckbox.type': 'checkbox', 'blankCheckbox.value': null },
  ];
  if (initialsKey) {
    set['fields.$[initials].value'] = initialsKey;
    set['fields.$[initials].filledAt'] = now;
    arrayFilters.push({ 'initials.recipientId': recipient.id, 'initials.type': 'initials' });
  }

  const update = await (await envelopes()).updateOne(
    {
      _id: envelope._id,
      status: 'sent',
      recipients: { $elemMatch: { id: recipient.id, status: { $in: AWAITING_STATUSES } } },
    },
    { $set: set },
    { arrayFilters },
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

  // Completion is decided after the signature events so the chain reads in the order things
  // happened. If this step is interrupted, the maintenance sweep completes the envelope later.
  const complete = await completeIfAllSigned(envelope, context);
  if (!complete) await inviteNextRecipients(envelope._id, context);

  return ok({ signed: true, envelopeCompleted: complete, signedAt: now });
});
