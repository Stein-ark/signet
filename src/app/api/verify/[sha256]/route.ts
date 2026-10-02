import { envelopes } from '@/lib/models/types';
import { SEALED_RECORD_FIELDS, checkSealedRecord } from '@/lib/pdf/seal';
import { notFound } from '@/lib/util/errors';
import { ok, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ sha256: string }> };

// Derived from the fields the check reads, so the projection cannot silently drop one again.
const projection = Object.fromEntries([
  ['_id', 1],
  ...SEALED_RECORD_FIELDS.map((field) => [`sealed.${field}`, 1]),
]);

export const GET = route(async (
  _request: Request,
  _context: RequestContext,
  routeContext: RouteContext,
): Promise<NextResponse> => {
  const { sha256 } = await routeContext.params;
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw notFound('No sealed agreement has this fingerprint.');

  const envelope = await (await envelopes()).findOne(
    {
      status: 'approved',
      $or: [
        { 'sealed.sha256': sha256 },
        { 'sealed.manifestDigest': sha256 },
      ],
    },
    { projection },
  );
  if (!envelope?.sealed) throw notFound('No sealed agreement has this fingerprint.');

  const result = checkSealedRecord(envelope._id.toHexString(), envelope.sealed);
  if (!('checks' in result)) return ok({ verified: false, reason: result.reason });
  const { manifest } = result;

  return ok({
    verified: result.verified,
    checks: result.checks,
    agreement: {
      id: envelope._id.toHexString(),
      title: typeof manifest.title === 'string' ? manifest.title : 'Sealed agreement',
      originalSha256: typeof manifest.originalSha256 === 'string' ? manifest.originalSha256 : null,
      contentSha256: typeof manifest.contentSha256 === 'string' ? manifest.contentSha256 : null,
      sealedSha256: envelope.sealed.sha256,
      sealedAt: envelope.sealed.sealedAt,
      pageCount: typeof manifest.pageCount === 'number' ? manifest.pageCount : null,
      signerCount: Array.isArray(manifest.signers) ? manifest.signers.length : null,
    },
  });
});
