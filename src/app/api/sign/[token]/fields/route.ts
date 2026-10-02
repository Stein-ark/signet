import { assertCsrf } from '@/lib/auth/session';
import { recordEvent } from '@/lib/audit/chain';
import { AWAITING_STATUSES } from '@/lib/envelopes/routing';
import { isCalendarDate } from '@/lib/envelopes/validation';
import { requireSigningActor } from '@/lib/signing/session';
import { envelopes, type FieldDoc } from '@/lib/models/types';
import { conflict } from '@/lib/util/errors';
import { assertSameOrigin, ok, readJson, route, type RequestContext } from '@/lib/util/http';
import { z } from 'zod';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ token: string }> };
const inputSchema = z.object({
  fields: z.array(z.object({
    id: z.string().uuid(),
    value: z.string().max(500),
  })).max(500),
});

export const PUT = route(async (
  request: Request,
  context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  assertSameOrigin(request);
  const { token } = await routeContext.params;
  const { envelope, recipient, session } = await requireSigningActor(token);
  assertCsrf(request, session);
  const input = await readJson(request, inputSchema);
  const values = new Map(input.fields.map((field) => [field.id, field.value]));
  if (values.size !== input.fields.length) throw conflict('Each signing field can only be included once.');

  const editable = new Map(envelope.fields
    .filter((field) => field.recipientId === recipient.id && (field.type === 'text' || field.type === 'date' || field.type === 'checkbox'))
    .map((field) => [field.id, field]));
  if ([...values.keys()].some((id) => !editable.has(id))) {
    throw conflict('One or more fields do not belong to this signing request.');
  }

  for (const [id, value] of values) {
    const field = editable.get(id)!;
    if (field.type === 'checkbox' && value !== 'true' && value !== 'false') {
      throw conflict('A checkbox value is not valid.');
    }
    if (field.type === 'date' && value !== '' && !isCalendarDate(value)) {
      throw conflict('A date field must be a valid date.');
    }
    if ((field.type === 'text' || field.type === 'date') && value.length > field.maxLength) {
      throw conflict('A field value is too long.');
    }
  }

  // Each value is written by array filter on its own field id and this recipient, so saving
  // never rewrites another recipient's fields and cannot conflict with them.
  const now = new Date();
  const set: Record<string, unknown> = { updatedAt: now };
  const arrayFilters: Record<string, unknown>[] = [];
  [...values.entries()].forEach(([id, value], index) => {
    const slot = `f${index}`;
    set[`fields.$[${slot}].value`] = value;
    set[`fields.$[${slot}].filledAt`] = now;
    arrayFilters.push({ [`${slot}.id`]: id, [`${slot}.recipientId`]: recipient.id });
  });

  const result = await (await envelopes()).updateOne(
    {
      _id: envelope._id,
      status: 'sent',
      recipients: { $elemMatch: { id: recipient.id, status: { $in: AWAITING_STATUSES } } },
    },
    { $set: set },
    arrayFilters.length ? { arrayFilters } : {},
  );
  if (result.matchedCount !== 1) throw conflict('This signing request changed. Reload and save again.');

  await recordEvent({
    envelopeId: envelope._id,
    versionGroupId: envelope.versionGroupId,
    type: 'recipient.fields_saved',
    actorType: 'recipient',
    actorId: recipient.id,
    actorEmail: recipient.email,
    actorName: recipient.name,
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { fieldCount: input.fields.length },
  });

  const saved: FieldDoc[] = envelope.fields
    .filter((field) => field.recipientId === recipient.id)
    .map((field) => values.has(field.id) ? { ...field, value: values.get(field.id)!, filledAt: now } : field);
  return ok({ saved: true, fields: saved });
});
