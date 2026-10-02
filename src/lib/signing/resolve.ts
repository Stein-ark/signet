import { envelopes, type EnvelopeDoc, type RecipientDoc } from '@/lib/models/types';
import { hashSecret } from '@/lib/util/crypto';
import { notFound } from '@/lib/util/errors';

export async function resolveSigningLink(token: string): Promise<{
  envelope: EnvelopeDoc;
  recipient: RecipientDoc;
}> {
  const tokenHash = hashSecret(token, 'signing-link');
  const envelope = await (await envelopes()).findOne({
    $or: [
      { 'recipients.tokenHash': tokenHash },
      { 'recipients.tokenHistory.hash': tokenHash },
    ],
  });
  const recipient = envelope?.recipients.find((item) =>
    item.tokenHash === tokenHash ||
    item.tokenHistory?.some((previous) => previous.hash === tokenHash && previous.expiresAt > new Date()),
  );
  if (!envelope || !recipient || envelope.status !== 'sent') throw notFound('This signing link is not available.');
  const tokenExpiresAt = recipient.tokenHash === tokenHash
    ? recipient.tokenExpiresAt
    : recipient.tokenHistory?.find((previous) => previous.hash === tokenHash)?.expiresAt;
  if (!tokenExpiresAt || tokenExpiresAt <= new Date()) {
    throw notFound('This signing link is not available.');
  }
  if (envelope.expiresAt <= new Date()) throw notFound('This signing link is not available.');
  if (recipient.status === 'signed' || recipient.status === 'declined') {
    throw notFound('This signing request has already been completed.');
  }

  if (envelope.signingOrder === 'sequential') {
    const next = [...envelope.recipients]
      .filter((item) => item.status !== 'signed')
      .sort((a, b) => a.routingOrder - b.routingOrder)[0];
    if (next?.id !== recipient.id) {
      throw notFound('This signing request will become available after the preceding signer completes.');
    }
  }

  return { envelope, recipient };
}
