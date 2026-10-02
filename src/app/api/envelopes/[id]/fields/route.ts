import { ObjectId } from 'mongodb';
import { requireOwner, assertCsrf } from '@/lib/auth/session';
import { recordEvent } from '@/lib/audit/chain';
import { fieldsInputSchema } from '@/lib/envelopes/validation';
import { envelopes, type FieldDoc } from '@/lib/models/types';
import { conflict, notFound } from '@/lib/util/errors';
import { assertSameOrigin, ok, readJson, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ id: string }> };

export const PUT = route(async (
  request: Request,
  context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  assertSameOrigin(request);
  const { session, user } = await requireOwner();
  assertCsrf(request, session);
  const { id } = await routeContext.params;
  if (!ObjectId.isValid(id)) throw notFound();
  const envelopeId = new ObjectId(id);
  const input = await readJson(request, fieldsInputSchema);
  const collection = await envelopes();
  const existing = await collection.findOne({ _id: envelopeId, ownerId: user._id, status: 'draft' });
  if (!existing) throw notFound();

  const recipientIds = new Set(existing.recipients.map((recipient) => recipient.id));
  const fields: FieldDoc[] = input.fields.map((field) => {
    if (!recipientIds.has(field.recipientId)) {
      throw notFound('Choose a recipient on this draft.');
    }
    if (field.page > existing.document.pageCount) {
      throw notFound('A field refers to a page that is not in this document.');
    }
    return {
      ...field,
      id: field.id,
      value: null,
      filledAt: null,
    };
  });

  const result = await collection.updateOne(
    { _id: envelopeId, ownerId: user._id, status: 'draft', updatedAt: existing.updatedAt },
    { $set: { fields, updatedAt: new Date() } },
  );
  if (result.matchedCount !== 1) throw conflict('This draft changed. Reload it and try again.');

  await recordEvent({
    envelopeId,
    versionGroupId: existing.versionGroupId,
    type: 'envelope.fields_updated',
    actorType: 'owner',
    actorId: user._id.toHexString(),
    actorEmail: user.email,
    actorName: user.name,
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { fieldCount: fields.length },
  });

  return ok({ fields: fields.map(({ id: fieldId, ...field }) => ({ id: fieldId, ...field })) });
});
