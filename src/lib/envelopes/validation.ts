import { z } from 'zod';
import { FIELD_TYPES } from '@/lib/models/types';

export const recipientInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  name: z.string().trim().max(100).default(''),
});

export const recipientsInputSchema = z.object({
  recipients: z.array(recipientInputSchema).min(1).max(50),
}).superRefine(({ recipients }, context) => {
  const seen = new Set<string>();
  for (const [index, recipient] of recipients.entries()) {
    if (seen.has(recipient.email)) {
      context.addIssue({
        code: 'custom',
        path: ['recipients', index, 'email'],
        message: 'Each recipient must have a unique email address.',
      });
    }
    seen.add(recipient.email);
  }
});

const fieldInputSchema = z.object({
  id: z.string().uuid(),
  recipientId: z.string().uuid(),
  page: z.number().int().positive(),
  type: z.enum(FIELD_TYPES),
  nx: z.number().finite().min(0).max(1),
  ny: z.number().finite().min(0).max(1),
  nw: z.number().finite().min(0.005).max(1),
  nh: z.number().finite().min(0.005).max(1),
  required: z.boolean(),
  label: z.string().trim().max(100).default(''),
  fontSize: z.number().finite().min(6).max(72).default(12),
  maxLength: z.number().int().min(1).max(500).default(200),
});

export const fieldsInputSchema = z.object({
  fields: z.array(fieldInputSchema).max(500),
}).superRefine(({ fields }, context) => {
  const seenIds = new Set<string>();
  for (const [index, field] of fields.entries()) {
    if (seenIds.has(field.id)) {
      context.addIssue({
        code: 'custom',
        path: ['fields', index, 'id'],
        message: 'Each field must have a unique identifier.',
      });
    }
    seenIds.add(field.id);
    if (field.nx + field.nw > 1.000001 || field.ny + field.nh > 1.000001) {
      context.addIssue({
        code: 'custom',
        path: ['fields', index],
        message: 'A field must fit within the page.',
      });
    }
  }
});

export const createEnvelopeSchema = z.object({
  title: z.string().trim().min(1).max(160),
});

/** A calendar date as the browser date input produces it, and a real day on the calendar. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
