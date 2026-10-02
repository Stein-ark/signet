import { ObjectId } from 'mongodb';
import { readSigningSession } from '@/lib/auth/session';
import { envelopes, type EnvelopeDoc, type RecipientDoc, type SessionDoc } from '@/lib/models/types';
import { resolveSigningLink } from '@/lib/signing/resolve';
import { unauthorized } from '@/lib/util/errors';

export async function requireSigningActor(token: string): Promise<{
  envelope: EnvelopeDoc;
  recipient: RecipientDoc;
  session: SessionDoc;
}> {
  const { envelope, recipient } = await resolveSigningLink(token);
  const session = await readSigningSession(envelope._id, recipient.id);
  if (!session) throw unauthorized('Verify your email address to continue signing.');
  return { envelope, recipient, session };
}

export async function signingDocumentById(id: ObjectId, recipientId: string): Promise<EnvelopeDoc | null> {
  return (await envelopes()).findOne(
    { _id: id, 'recipients.id': recipientId, status: 'sent' },
    { projection: { 'document.key': 1, 'document.filename': 1, 'document.size': 1, 'document.pages': 1, 'document.pageCount': 1, title: 1 } },
  );
}
