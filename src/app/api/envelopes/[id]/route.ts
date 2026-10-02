import { ObjectId } from 'mongodb';
import { requireOwner } from '@/lib/auth/session';
import { envelopes } from '@/lib/models/types';
import { notFound } from '@/lib/util/errors';
import { ok, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ id: string }> };

export const GET = route(async (
  _request: Request,
  _context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  const { user } = await requireOwner();
  const { id } = await routeContext.params;
  if (!ObjectId.isValid(id)) throw notFound();

  const envelope = await (await envelopes()).findOne({
    _id: new ObjectId(id),
    ownerId: user._id,
  });
  if (!envelope) throw notFound();

  return ok({
    envelope: {
      id: envelope._id.toHexString(),
      title: envelope.title,
      status: envelope.status,
      message: envelope.message,
      signingOrder: envelope.signingOrder,
      recipients: envelope.recipients.map(({ id: recipientId, name, email, routingOrder }) => ({
        id: recipientId,
        name,
        email,
        routingOrder,
      })),
      fields: envelope.fields.map(({ id: fieldId, recipientId, page, type, nx, ny, nw, nh, required, label, fontSize, maxLength }) => ({
        id: fieldId,
        recipientId,
        page,
        type,
        nx,
        ny,
        nw,
        nh,
        required,
        label,
        fontSize,
        maxLength,
      })),
      document: {
        filename: envelope.document.filename,
        pageCount: envelope.document.pageCount,
        pages: envelope.document.pages,
      },
    },
  });
});
