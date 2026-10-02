import type { EnvelopeDoc, RecipientDoc, RecipientStatus } from '@/lib/models/types';

/** Statuses of a recipient who has been invited and has not yet signed or declined. */
export const AWAITING_STATUSES: RecipientStatus[] = ['invited', 'viewed', 'verified'];

export function isAwaiting(recipient: RecipientDoc): boolean {
  return AWAITING_STATUSES.includes(recipient.status);
}

/**
 * The recipients who may act right now.
 *
 * In parallel routing that is everyone still waiting. In sequential routing it is the waiting
 * recipients holding the lowest routing order that has not finished signing, so recipients who
 * share a routing order act together and later ones wait until that group has signed.
 */
export function recipientsUpNext(
  envelope: Pick<EnvelopeDoc, 'signingOrder' | 'recipients'>,
): RecipientDoc[] {
  const awaiting = envelope.recipients.filter(isAwaiting);
  if (envelope.signingOrder !== 'sequential') return awaiting;

  const unsigned = envelope.recipients.filter((recipient) => recipient.status !== 'signed');
  if (!unsigned.length) return [];
  const currentOrder = Math.min(...unsigned.map((recipient) => recipient.routingOrder));
  return awaiting.filter((recipient) => recipient.routingOrder === currentOrder);
}
