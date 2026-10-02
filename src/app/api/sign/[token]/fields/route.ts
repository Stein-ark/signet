import { assertCsrf } from '@/lib/auth/session';
import { recordEvent } from '@/lib/audit/chain';
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

  const ownIds = new Set(envelope.fields
    .filter((field) => field.recipientId === recipient.id && (field.type === 'text' || field.type === 'date' || field.type === 'checkbox'))
    .map((field) => field.id));
  if ([...values.keys()].some((id) => !ownIds.has(id))) {
    throw conflict('One or more fields do not belong to this signing request.');
  }

  const now = new Date();
  const fields: FieldDoc[] = envelope.fields.map((field) => {
    const value = values.get(field.id);
    if (value === undefined) return field;
    if (field.type === 'checkbox' && value !== 'true' && value !== 'false') {
      throw conflict('A checkbox value is not valid.');
    }
    if ((field.type === 'text' || field.type === 'date') && value.length > field.maxLength) {
      throw conflict('A field value is too long.');
    }
    return { ...field, value, filledAt: now };
  });

  const result = await (await envelopes()).updateOne(
    { _id: envelope._id, status: 'sent', updatedAt: envelope.updatedAt },
    { $set: { fields, updatedAt: now } },
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

  return ok({ saved: true, fields: fields.filter((field) => field.recipientId === recipient.id) });
});
