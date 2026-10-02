import { describe, expect, it } from 'vitest';
import { fieldsInputSchema, recipientsInputSchema } from '@/lib/envelopes/validation';

describe('recipient input validation', () => {
  it('normalizes addresses', () => {
    const result = recipientsInputSchema.safeParse({
      recipients: [{ name: 'Jordan', email: ' JORDAN@example.com ' }],
    });

    expect(result.success && result.data.recipients[0]?.email).toBe('jordan@example.com');
  });

  it('rejects duplicate normalized addresses', () => {
    const result = recipientsInputSchema.safeParse({
      recipients: [
        { name: 'Jordan', email: ' JORDAN@example.com ' },
        { name: 'Jordan again', email: 'jordan@example.com' },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('requires at least one recipient and caps the list', () => {
    expect(recipientsInputSchema.safeParse({ recipients: [] }).success).toBe(false);
    expect(
      recipientsInputSchema.safeParse({
        recipients: Array.from({ length: 51 }, (_, index) => ({
          email: `signer${index}@example.com`,
          name: '',
        })),
      }).success,
    ).toBe(false);
  });
});

describe('field placement validation', () => {
  const validField = {
    id: 'eeb15977-49ae-4d7f-b76a-c15705cd08d7',
    recipientId: '5cb8d27b-b6be-4e96-af5a-f6949e744f18',
    page: 1,
    type: 'signature',
    nx: 0.7,
    ny: 0.8,
    nw: 0.25,
    nh: 0.1,
    required: true,
    label: 'Signature',
    fontSize: 12,
    maxLength: 200,
  };

  it('accepts normalized rectangles within page bounds', () => {
    expect(fieldsInputSchema.safeParse({ fields: [validField] }).success).toBe(true);
  });

  it('rejects off-page rectangles and duplicate identifiers', () => {
    expect(
      fieldsInputSchema.safeParse({
        fields: [{ ...validField, nx: 0.9 }, { ...validField, id: '751017f7-fec6-4abf-9739-853cd2278b18' }],
      }).success,
    ).toBe(false);
    expect(
      fieldsInputSchema.safeParse({ fields: [validField, validField] }).success,
    ).toBe(false);
  });
});
