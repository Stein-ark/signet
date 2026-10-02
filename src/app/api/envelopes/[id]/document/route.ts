import { ObjectId } from 'mongodb';
import { Readable } from 'node:stream';
import { requireOwner } from '@/lib/auth/session';
import { envelopes } from '@/lib/models/types';
import { storage } from '@/lib/storage/index';
import { notFound } from '@/lib/util/errors';
import { route, type RequestContext } from '@/lib/util/http';
import { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ id: string }> };

export const runtime = 'nodejs';

export const GET = route(async (
  _request: Request,
  _context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  const { user } = await requireOwner();
  const { id } = await routeContext.params;
  if (!ObjectId.isValid(id)) throw notFound();
  const envelope = await (await envelopes()).findOne(
    { _id: new ObjectId(id), ownerId: user._id },
    { projection: { 'document.key': 1, 'document.filename': 1, 'document.size': 1 } },
  );
  if (!envelope) throw notFound();

  const stream = await storage().stream(envelope.document.key);
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  const safeFilename = envelope.document.filename.replace(/["\r\n]/g, '_');
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(envelope.document.size),
      'Content-Disposition': `inline; filename="${safeFilename}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store, private',
    },
  });
});
