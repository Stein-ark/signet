import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { requireOwner, assertCsrf } from '@/lib/auth/session';
import { recordEvent } from '@/lib/audit/chain';
import { envelopes, type EnvelopeDoc } from '@/lib/models/types';
import { inspectPdf } from '@/lib/pdf/inspect';
import { storage, storageKey } from '@/lib/storage/index';
import { env } from '@/lib/env';
import { badRequest, tooLarge } from '@/lib/util/errors';
import { assertSameOrigin, ok, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

export const runtime = 'nodejs';

function emptyEnvelope(
  envelopeId: ObjectId,
  owner: { _id: ObjectId; email: string; name: string },
  title: string,
  file: { name: string; size: number; sha256: string; pageCount: number; pages: EnvelopeDoc['document']['pages']; key: string },
): EnvelopeDoc {
  const now = new Date();
  return {
    _id: envelopeId,
    ownerId: owner._id,
    ownerEmail: owner.email,
    ownerName: owner.name,
    versionGroupId: new ObjectId(),
    version: 1,
    supersedesId: null,
    supersededById: null,
    title,
    message: '',
    status: 'draft',
    signingOrder: 'parallel',
    ownerIsSigner: false,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    document: {
      key: file.key,
      sha256: file.sha256,
      size: file.size,
      contentType: 'application/pdf',
      filename: file.name,
      pageCount: file.pageCount,
      pages: file.pages,
    },
    sealed: null,
    recipients: [],
    fields: [],
    distribution: {
      approvedAt: null,
      approvedBy: null,
      deliveredAt: null,
      deliveredTo: [],
    },
    reminder: { intervalHours: 24, nextAt: null, sentCount: 0 },
    createdAt: now,
    updatedAt: now,
    sentAt: null,
    completedAt: null,
    voidedAt: null,
    voidReason: null,
  };
}

export const GET = route(async (_request: Request, _context: RequestContext): Promise<NextResponse> => {
  const { user } = await requireOwner();
  const rows = await (
    await envelopes()
  )
    .find(
      { ownerId: user._id },
      {
        projection: {
          title: 1,
          status: 1,
          updatedAt: 1,
          'recipients.name': 1,
          'recipients.email': 1,
        },
      },
    )
    .sort({ updatedAt: -1 })
    .limit(50)
    .toArray();

  return ok({
    envelopes: rows.map((envelope) => ({
      id: envelope._id.toHexString(),
      title: envelope.title,
      status: envelope.status,
      updatedAt: envelope.updatedAt,
      recipients: envelope.recipients,
    })),
  });
});

export const POST = route(async (request: Request, context: RequestContext): Promise<NextResponse> => {
  assertSameOrigin(request);
  const { session, user } = await requireOwner();
  assertCsrf(request, session);

  const maxBytes = env().MAX_UPLOAD_BYTES;
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) {
    throw badRequest('The upload size could not be verified. Try again.');
  }
  if (declaredLength > maxBytes + 1024 * 1024) {
    throw tooLarge(`The upload must be smaller than ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    throw badRequest('Upload a PDF using the document form.');
  }

  const form = await request.formData();
  const file = form.get('file');
  const titleValue = form.get('title');
  if (!(file instanceof File)) throw badRequest('Choose a PDF to upload.');
  if (file.size === 0) throw badRequest('That PDF is empty.');
  if (file.size > maxBytes) {
    throw tooLarge(`The upload must be smaller than ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
  }
  if (typeof titleValue !== 'string' || !titleValue.trim() || titleValue.trim().length > 160) {
    throw badRequest('Add a title of 1 to 160 characters.');
  }
  if (file.type && file.type !== 'application/pdf') {
    throw badRequest('Choose a PDF file.');
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const geometry = await inspectPdf(bytes);
  const envelopeId = new ObjectId();
  const key = storageKey('envelopes', envelopeId.toHexString(), 'original', 'pdf');
  const envelope = emptyEnvelope(envelopeId, user, titleValue.trim(), {
    name: file.name.replace(/[\r\n/\\]/g, '_').slice(0, 180) || 'document.pdf',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pageCount: geometry.pageCount,
    pages: geometry.pages,
    key,
  });
  await storage().put(key, bytes, 'application/pdf');
  try {
    await (await envelopes()).insertOne(envelope);
    await recordEvent({
      envelopeId,
      versionGroupId: envelope.versionGroupId,
      type: 'envelope.created',
      actorType: 'owner',
      actorId: user._id.toHexString(),
      actorEmail: user.email,
      actorName: user.name,
      ip: context.ip,
      userAgent: context.userAgent,
      meta: {
        title: envelope.title,
        filename: envelope.document.filename,
        documentSha256: envelope.document.sha256,
        documentSize: envelope.document.size,
        pageCount: envelope.document.pageCount,
      },
    });
  } catch (error) {
    const cleanupResults = await Promise.allSettled([
      (async () => {
        await (await envelopes()).deleteOne({ _id: envelopeId });
      })(),
      storage().remove(key),
    ]);
    const cleanupErrors = cleanupResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (cleanupErrors.length) {
      console.error('[signet] failed to clean up uncommitted document upload', cleanupErrors);
      throw new AggregateError([error, ...cleanupErrors], 'Document upload failed and cleanup needs attention.');
    }
    throw error;
  }

  return ok(
    {
      envelope: {
        id: envelopeId.toHexString(),
        title: envelope.title,
        status: envelope.status,
        pageCount: envelope.document.pageCount,
      },
    },
    { status: 201 },
  );
});
