import { describe, expect, it } from 'vitest';
import { missingEvidence } from '@/lib/audit/evidence';
import type { AuditEventType, RecipientDoc } from '@/lib/models/types';

const recipients = [
  { id: 'r1', name: 'Ada', email: 'ada@example.com' },
  { id: 'r2', name: 'Grace', email: 'grace@example.com' },
] as RecipientDoc[];

const signed = (id: string): { type: AuditEventType; actorId: string }[] => [
  { type: 'recipient.otp_verified', actorId: id },
  { type: 'recipient.consented', actorId: id },
  { type: 'recipient.signed', actorId: id },
];

const complete = [
  { type: 'envelope.sent' as const, actorId: 'owner' },
  ...signed('r1'),
  ...signed('r2'),
  { type: 'envelope.completed' as const, actorId: null },
];

describe('approval evidence', () => {
  it('accepts a trail that records every step', () => {
    expect(missingEvidence({ recipients }, complete)).toBeNull();
  });

  it('names the signer whose signature event is missing', () => {
    const events = complete.filter((event) => !(event.type === 'recipient.signed' && event.actorId === 'r2'));
    expect(missingEvidence({ recipients }, events)).toMatch(/Grace signing/);
  });

  it('does not accept one signer’s event as evidence for another', () => {
    const events = [
      { type: 'envelope.sent' as const, actorId: 'owner' },
      ...signed('r1'),
      ...signed('r1'),
      { type: 'envelope.completed' as const, actorId: null },
    ];
    expect(missingEvidence({ recipients }, events)).toMatch(/Grace/);
  });

  it('requires the completion event', () => {
    expect(missingEvidence({ recipients }, complete.slice(0, -1))).toMatch(/completed/);
  });
});
