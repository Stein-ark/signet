import { ObjectId } from 'mongodb';
import { assertCsrf, requireOwner } from '@/lib/auth/session';
import { readChain, recordEvent, verifyChain } from '@/lib/audit/chain';
import { missingEvidence } from '@/lib/audit/evidence';
import { storage, storageKey } from '@/lib/storage/index';
import { envelopes } from '@/lib/models/types';
import { issuerPublicKeyBase64, sealEnvelope } from '@/lib/pdf/seal';
import { conflict, notFound } from '@/lib/util/errors';
import { assertSameOrigin, ok, route, type RequestContext } from '@/lib/util/http';
import { canonicalJson } from '@/lib/util/crypto';
import type { NextResponse } from 'next/server';

type RouteContext = { params: Promise<{ id: string }> };
const APPROVAL_CLAIM_MAX_AGE_MS = 10 * 60 * 1000;

export const POST = route(async (
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
  const collection = await envelopes();
  const envelope = await collection.findOne({
    _id: envelopeId,
    ownerId: user._id,
    status: 'completed',
  });
  if (!envelope) throw notFound();

  if (!envelope.recipients.length || envelope.recipients.some((recipient) => recipient.status !== 'signed')) {
    throw conflict('Every recipient must sign before you can approve this agreement.');
  }
  const missingField = envelope.fields.find(
    (field) => field.required && (field.value === null || field.value === ''),
  );
  if (missingField) throw conflict(`A required ${missingField.label || missingField.type} field is incomplete.`);
  if (envelope.recipients.some((recipient) => !recipient.signatureKey || !recipient.consent)) {
    throw conflict('A signer is missing their signature or recorded consent.');
  }
  const gap = missingEvidence(envelope, await readChain(envelopeId));
  if (gap) throw conflict(`${gap} Approval was not completed.`);

  const now = new Date();
  const staleClaim = new Date(now.getTime() - APPROVAL_CLAIM_MAX_AGE_MS);
  const claim = await collection.updateOne(
    {
      _id: envelopeId,
      ownerId: user._id,
      status: 'completed',
      updatedAt: envelope.updatedAt,
      $or: [
        { 'distribution.approvalClaimAt': null },
        { 'distribution.approvalClaimAt': { $exists: false } },
        { 'distribution.approvalClaimAt': { $lt: staleClaim } },
      ],
    },
    {
      $set: {
        'distribution.approvalClaimAt': now,
        'distribution.approvedAt': now,
        'distribution.approvedBy': user._id,
      },
    },
  );
  if (claim.matchedCount !== 1) throw conflict('This agreement is already being approved. Refresh and check its status.');

  let sealedKey: string | null = null;
  let persisted = false;
  try {
    await recordEvent({
      envelopeId,
      versionGroupId: envelope.versionGroupId,
      type: 'envelope.approved',
      actorType: 'owner',
      actorId: user._id.toHexString(),
      actorEmail: user.email,
      actorName: user.name,
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { approvedAt: now.toISOString() },
    });

    const events = await readChain(envelopeId);
    const verification = verifyChain(events);
    if (!verification.valid) {
      throw conflict(`The audit chain does not verify at event ${verification.brokenAt}. Approval was not completed.`);
    }
    const auditRows = events.map((event) => ({
      seq: event.seq,
      at: event.at.toISOString(),
      type: event.type,
      actor: event.actorName || event.actorEmail || event.actorType,
      ip: event.ip,
      hash: event.hash,
    }));

    const approvalEnvelope = {
      ...envelope,
      distribution: {
        ...envelope.distribution,
        approvedAt: now,
        approvedBy: user._id,
      },
    };
    const result = await sealEnvelope({
      envelope: approvalEnvelope,
      auditRows,
      auditChainHead: verification.head,
    });
    const sealedAt = new Date(result.manifest.sealedAt);
    sealedKey = storageKey('envelopes', envelopeId.toHexString(), 'sealed', 'pdf');
    await storage().put(sealedKey, result.bytes, 'application/pdf');

    const manifestJson = canonicalJson(result.manifest);
    const updated = await collection.updateOne(
      {
        _id: envelopeId,
        ownerId: user._id,
        status: 'completed',
        'distribution.approvalClaimAt': now,
      },
      {
        $set: {
          status: 'approved',
          sealed: {
            key: sealedKey,
            sha256: result.sha256,
            size: result.bytes.length,
            contentType: 'application/pdf',
            contentSha256: result.contentSha256,
            signature: result.signature,
            manifestDigest: result.manifestDigest,
            manifestJson,
            publicKey: issuerPublicKeyBase64(),
            sealedAt,
          },
          'distribution.approvedAt': now,
          'distribution.approvedBy': user._id,
          'distribution.approvalClaimAt': null,
          updatedAt: new Date(),
        },
      },
    );
    if (updated.matchedCount !== 1) throw conflict('Approval could not be finalized. Refresh and try again.');
    persisted = true;

    await recordEvent({
      envelopeId,
      versionGroupId: envelope.versionGroupId,
      type: 'envelope.sealed',
      actorType: 'owner',
      actorId: user._id.toHexString(),
      actorEmail: user.email,
      actorName: user.name,
      ip: context.ip,
      userAgent: context.userAgent,
      meta: {
        sealedSha256: result.sha256,
        contentSha256: result.contentSha256,
        manifestDigest: result.manifestDigest,
        certificatePages: result.certificatePages,
      },
    });

    return ok({
      envelope: { id: envelopeId.toHexString(), status: 'approved' },
      sealed: {
        sha256: result.sha256,
        size: result.bytes.length,
        sealedAt,
        certificatePages: result.certificatePages,
      },
    });
  } catch (error) {
    if (persisted) {
      console.error(`[signet] sealed document persisted but final audit event failed envelope=${envelopeId.toHexString()}`, error);
      throw new Error('The document is sealed, but the final audit event could not be recorded. Contact support before retrying.', { cause: error });
    }

    const cleanup = await Promise.allSettled([
      collection.updateOne(
        {
          _id: envelopeId,
          status: 'completed',
          'distribution.approvalClaimAt': now,
        },
        {
          $set: {
            'distribution.approvalClaimAt': null,
            'distribution.approvedAt': null,
            'distribution.approvedBy': null,
          },
        },
      ),
      ...(sealedKey ? [storage().remove(sealedKey)] : []),
    ]);
    const failures = cleanup
      .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
      .map((item) => item.reason);
    if (failures.length) {
      console.error(`[signet] approval cleanup failed envelope=${envelopeId.toHexString()}`, failures);
      throw new AggregateError([error, ...failures], 'Approval failed and cleanup needs attention.');
    }
    throw error;
  }
});
