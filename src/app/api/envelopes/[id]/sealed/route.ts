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
    { _id: new ObjectId(id), ownerId: user._id, status: 'approved', 'sealed.key': { $type: 'string' } },
    { projection: { 'sealed.key': 1, 'sealed.size': 1, 'sealed.sha256': 1 } },
  );
  if (!envelope?.sealed) throw notFound();

  const stream = await storage().stream(envelope.sealed.key);
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(envelope.sealed.size),
      'Content-Disposition': 'attachment; filename="signet-sealed-agreement.pdf"',
      'X-Content-Type-Options': 'nosniff',
      'Digest': `sha-256=${Buffer.from(envelope.sealed.sha256, 'hex').toString('base64')}`,
      'Cache-Control': 'no-store, private',
    },
  });
});
