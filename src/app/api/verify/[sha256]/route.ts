import { envelopes } from '@/lib/models/types';
import { verifyManifestSignature } from '@/lib/pdf/seal';
import { sha256Hex } from '@/lib/util/crypto';
import { notFound } from '@/lib/util/errors';
import { ok, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ sha256: string }> };

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
    {
      projection: {
        _id: 1,
        'sealed.sha256': 1,
        'sealed.manifestDigest': 1,
        'sealed.manifestJson': 1,
        'sealed.signature': 1,
        'sealed.publicKey': 1,
        'sealed.sealedAt': 1,
      },
    },
  );
  if (!envelope?.sealed) throw notFound('No sealed agreement has this fingerprint.');

  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(envelope.sealed.manifestJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Manifest is not an object.');
    manifest = parsed as Record<string, unknown>;
  } catch {
    return ok({ verified: false, reason: 'manifest_invalid' });
  }

  const digestMatches = sha256Hex(envelope.sealed.manifestJson) === envelope.sealed.manifestDigest;
  const signatureValid = digestMatches && verifyManifestSignature(
    envelope.sealed.manifestJson,
    envelope.sealed.signature,
    envelope.sealed.publicKey,
  );
  const documentMatches =
    manifest.envelopeId === envelope._id.toHexString() &&
    manifest.sealedAt === envelope.sealed.sealedAt.toISOString() &&
    manifest.contentSha256 === envelope.sealed.contentSha256;

  return ok({
    verified: signatureValid && documentMatches,
    checks: {
      manifestDigest: digestMatches,
      issuerSignature: signatureValid,
      documentRecord: documentMatches,
    },
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
