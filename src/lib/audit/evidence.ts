import type { AuditEventDoc, EnvelopeDoc } from '@/lib/models/types';

/**
 * Confirm the audit trail actually records what the envelope claims happened.
 *
 * State changes and their audit events are separate writes, so a crash between the two can leave
 * an envelope that says "signed" with no event to prove it. Sealing such an envelope would
 * certify a signature the trail cannot support, so approval checks the trail first.
 *
 * Returns a human readable description of the first gap, or null when the evidence is complete.
 */
export function missingEvidence(
  envelope: Pick<EnvelopeDoc, 'recipients'>,
  events: Pick<AuditEventDoc, 'type' | 'actorId'>[],
): string | null {
  const has = (type: AuditEventDoc['type'], actorId?: string) =>
    events.some((event) => event.type === type && (actorId === undefined || event.actorId === actorId));

  if (!has('envelope.sent')) return 'The audit trail does not record this agreement being sent.';
  for (const recipient of envelope.recipients) {
    const who = recipient.name || recipient.email;
    if (!has('recipient.otp_verified', recipient.id)) {
      return `The audit trail does not record ${who} verifying their email address.`;
    }
    if (!has('recipient.consented', recipient.id)) {
      return `The audit trail does not record ${who} consenting to sign electronically.`;
    }
    if (!has('recipient.signed', recipient.id)) {
      return `The audit trail does not record ${who} signing.`;
    }
  }
  if (!has('envelope.completed')) return 'The audit trail does not record this agreement being completed.';
  return null;
}
