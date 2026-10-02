import { Readable } from 'node:stream';
import { requireSigningActor, signingDocumentById } from '@/lib/signing/session';
import { storage } from '@/lib/storage/index';
import { notFound } from '@/lib/util/errors';
import { route, type RequestContext } from '@/lib/util/http';
import { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ token: string }> };
export const runtime = 'nodejs';

export const GET = route(async (
  _request: Request,
  _context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  const { token } = await routeContext.params;
  const { envelope, recipient } = await requireSigningActor(token);
  const document = await signingDocumentById(envelope._id, recipient.id);
  if (!document) throw notFound();
  const stream = await storage().stream(document.document.key);
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(document.document.size),
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store, private',
    },
  });
});
