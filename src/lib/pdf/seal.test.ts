import { ObjectId } from 'mongodb';
import { PDFDocument, degrees } from '@cantoo/pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { inspectPdf } from '@/lib/pdf/inspect';
import { checkSealedRecord, sealEnvelope, type SealResult, type SealedRecord } from '@/lib/pdf/seal';
import { storage, storageKey } from '@/lib/storage/index';
import { canonicalJson, sha256Hex } from '@/lib/util/crypto';
import type { EnvelopeDoc, FieldDoc, RecipientDoc } from '@/lib/models/types';
import { makePng } from '@/test/png';

const envelopeId = new ObjectId();
let envelope: EnvelopeDoc;
let result: SealResult;
let record: SealedRecord;

function field(overrides: Partial<FieldDoc>): FieldDoc {
  return {
    id: crypto.randomUUID(),
    recipientId: 'r1',
    page: 1,
    type: 'text',
    nx: 0.1,
    ny: 0.1,
    nw: 0.3,
    nh: 0.05,
    required: true,
    label: '',
    fontSize: 12,
    maxLength: 200,
    value: null,
    filledAt: null,
    ...overrides,
  };
}

beforeAll(async () => {
  const source = await PDFDocument.create();
  source.addPage([612, 792]);
  source.addPage([612, 792]).setRotation(degrees(90));
  const bytes = Buffer.from(await source.save());
  const geometry = await inspectPdf(bytes);

  const originalKey = storageKey('envelopes', envelopeId.toHexString(), 'original', 'pdf');
  const signatureKey = storageKey('envelopes', envelopeId.toHexString(), 'signature', 'png');
  await storage().put(originalKey, bytes, 'application/pdf');
  await storage().put(signatureKey, makePng(), 'image/png');

  const now = new Date();
  envelope = {
    _id: envelopeId,
    ownerId: new ObjectId(),
    ownerEmail: 'owner@example.com',
    ownerName: 'Owner',
    versionGroupId: new ObjectId(),
    version: 1,
    supersedesId: null,
    supersededById: null,
    title: 'Services agreement',
    message: '',
    status: 'completed',
    signingOrder: 'parallel',
    ownerIsSigner: false,
    expiresAt: new Date(now.getTime() + 86_400_000),
    document: {
      key: originalKey,
      sha256: sha256Hex(bytes),
      size: bytes.length,
      contentType: 'application/pdf',
      filename: 'agreement.pdf',
      pageCount: geometry.pageCount,
      pages: geometry.pages,
    },
    sealed: null,
    recipients: [{
      id: 'r1',
      email: 'ada@example.com',
      name: 'Ada',
      routingOrder: 1,
      isOwner: false,
      status: 'signed',
      consent: { agreedAt: now, text: 'I agree.', adoptedName: 'Ada L', signatureType: 'drawn' },
      signatureKey,
      initialsKey: null,
      signedAt: now,
      otp: { hash: null, expiresAt: null, attempts: 0, sentAt: null, resendCount: 1, verifiedAt: now },
      lastIp: '198.51.100.9',
      lastUserAgent: 'test',
    } as unknown as RecipientDoc],
    fields: [
      field({ type: 'signature', value: signatureKey }),
      field({ type: 'text', value: 'Ada Lovelace', ny: 0.3 }),
      field({ type: 'date', value: '2026-10-02', ny: 0.4 }),
      field({ type: 'checkbox', value: 'true', ny: 0.5, nw: 0.04, nh: 0.04 }),
      field({ type: 'signature', value: signatureKey, page: 2 }),
    ],
    distribution: { approvedAt: now, approvedBy: new ObjectId(), deliveredAt: null, deliveredTo: [] },
    reminder: { intervalHours: 24, nextAt: null, sentCount: 0 },
    createdAt: now,
    updatedAt: now,
    sentAt: now,
    completedAt: now,
    voidedAt: null,
    voidReason: null,
  };

  result = await sealEnvelope({
    envelope,
    auditRows: [{ seq: 1, at: now.toISOString(), type: 'envelope.created', actor: 'Owner', ip: '198.51.100.9', hash: 'a'.repeat(64) }],
    auditChainHead: 'a'.repeat(64),
  });
  record = {
    sha256: result.sha256,
    contentSha256: result.contentSha256,
    manifestDigest: result.manifestDigest,
    // The stored manifest is the canonical JSON that was signed.
    manifestJson: canonicalJson(result.manifest),
    signature: result.signature,
    publicKey: process.env.SEAL_PUBLIC_KEY!,
    sealedAt: new Date(result.manifest.sealedAt),
  };
});

describe('sealing', () => {
  it('produces a readable PDF with the certificate appended and a matching fingerprint', async () => {
    const sealed = await PDFDocument.load(result.bytes);
    expect(sealed.getPageCount()).toBe(2 + result.certificatePages);
    expect(result.sha256).toBe(sha256Hex(result.bytes));
    expect(result.manifest.originalSha256).toBe(envelope.document.sha256);
  });

  it('leaves no interactive form behind', async () => {
    const sealed = await PDFDocument.load(result.bytes);
    expect(sealed.getForm().getFields()).toHaveLength(0);
  });
});

describe('seal verification', () => {
  it('verifies a genuine seal', () => {
    const verification = checkSealedRecord(envelopeId.toHexString(), record);
    expect(verification).toMatchObject({
      verified: true,
      checks: { manifestDigest: true, issuerSignature: true, documentRecord: true },
    });
  });

  it('fails when the stored record lacks the content fingerprint', () => {
    // The regression behind "every seal reports unverified": a query that did not load
    // contentSha256 made the record check fail for genuine documents.
    const partial = { ...record, contentSha256: undefined } as unknown as SealedRecord;
    expect(checkSealedRecord(envelopeId.toHexString(), partial)).toMatchObject({
      verified: false,
      checks: { documentRecord: false },
    });
  });

  it('rejects an edited manifest', () => {
    const edited = { ...record, manifestJson: record.manifestJson.replace('Services agreement', 'Other agreement') };
    expect(checkSealedRecord(envelopeId.toHexString(), edited)).toMatchObject({
      verified: false,
      checks: { manifestDigest: false, issuerSignature: false },
    });
  });

  it('rejects a manifest re-signed with another key', async () => {
    const { generateKeyPairSync, sign } = await import('node:crypto');
    const other = generateKeyPairSync('ed25519');
    const forged = {
      ...record,
      signature: sign(null, Buffer.from(record.manifestJson), other.privateKey).toString('base64'),
    };
    expect(checkSealedRecord(envelopeId.toHexString(), forged)).toMatchObject({
      verified: false,
      checks: { issuerSignature: false },
    });
  });

  it('rejects a seal presented for a different envelope', () => {
    expect(checkSealedRecord(new ObjectId().toHexString(), record).verified).toBe(false);
  });

  it('reports a manifest that is not valid JSON', () => {
    expect(checkSealedRecord(envelopeId.toHexString(), { ...record, manifestJson: '{' })).toEqual({
      verified: false,
      reason: 'manifest_invalid',
    });
  });
});
