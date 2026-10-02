import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from '@cantoo/pdf-lib';
import type { EnvelopeDoc, FieldDoc, PageGeometry } from '@/lib/models/types';
import { localOffset, placeRect, type PlacedRect } from '@/lib/pdf/coordinates';
import { sanitizeForPdf, truncateToWidth } from '@/lib/pdf/text';
import {
  appendCertificate,
  type CertificateAuditRow,
  type CertificateManifest,
  type SealBlock,
} from '@/lib/pdf/certificate';
import { canonicalJson, sha256Hex } from '@/lib/util/crypto';
import { env } from '@/lib/env';
import { storage } from '@/lib/storage/index';

/**
 * Sealing: turning a filled envelope into a finished legal artifact.
 *
 * The pipeline, in order, and why each step is where it is:
 *
 *   1. Load the original and neutralise anything active in it. A sealed document must be inert:
 *      no interactive form a later reader could retype, no automatic action, no embedded script.
 *   2. Stamp every collected value into the page content stream. Values are drawn as content,
 *      not as form widgets, so there is no editable layer left behind at all.
 *   3. Build the evidence manifest and sign it with the issuer key.
 *   4. Append the signing certificate carrying the manifest, the audit trail and the seal.
 *   5. Save once and fingerprint the result. That fingerprint is what a verifier checks.
 *
 * The manifest is signed before the certificate is drawn, which is what allows a single save
 * pass: everything printed on the certificate is either known in advance or derived from the
 * manifest, so the document never has to be hashed, reopened and stamped again.
 */

export type SealInput = {
  envelope: EnvelopeDoc;
  auditRows: CertificateAuditRow[];
  auditChainHead: string;
};

export type SealResult = {
  bytes: Buffer;
  /** SHA-256 of the finished file. This is the value a verifier recomputes. */
  sha256: string;
  /** SHA-256 of the filled document before the certificate was appended. */
  contentSha256: string;
  manifest: CertificateManifest;
  manifestDigest: string;
  signature: string;
  certificatePages: number;
};

/* ------------------------------------------------------------------ *
 * Issuer key handling
 * ------------------------------------------------------------------ */

function issuerPrivateKey() {
  return createPrivateKey({
    key: Buffer.from(env().SEAL_PRIVATE_KEY, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

export function issuerPublicKeyBase64(): string {
  return env().SEAL_PUBLIC_KEY;
}

/** Sign an arbitrary message with the issuer Ed25519 key. */
export function signManifest(message: string): string {
  return edSign(null, Buffer.from(message, 'utf8'), issuerPrivateKey()).toString('base64');
}

/**
 * Check a signature against a public key. Used by the public verification page so that a third
 * party can confirm a certificate was issued by this deployment and not fabricated.
 */
export function verifyManifestSignature(
  message: string,
  signatureBase64: string,
  publicKeyBase64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return edVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * The pipeline
 * ------------------------------------------------------------------ */

export async function sealEnvelope(input: SealInput): Promise<SealResult> {
  const { envelope, auditRows, auditChainHead } = input;

  const originalBytes = await storage().get(envelope.document.key);
  const document = await PDFDocument.load(originalBytes, {
    ignoreEncryption: false,
    updateMetadata: false,
  });

  neutraliseActiveContent(document);

  const fonts = {
    regular: await document.embedFont(StandardFonts.Helvetica),
  };

  await stampFields(document, envelope, fonts);

  // Fingerprint of the filled document before evidence is appended. Recorded so an auditor can
  // distinguish "the agreement pages" from "the agreement plus its certificate".
  const filledBytes = Buffer.from(await document.save({ useObjectStreams: false }));
  const contentSha256 = sha256Hex(filledBytes);

  const manifest = buildManifest(envelope, auditRows.length, auditChainHead, contentSha256);
  const manifestJson = canonicalJson(manifest);
  const manifestDigest = sha256Hex(manifestJson);
  const signature = signManifest(manifestJson);

  const seal: SealBlock = {
    manifestDigest,
    signature,
    publicKey: issuerPublicKeyBase64(),
    verifyUrl: `${env().APP_URL.replace(/\/$/, '')}/verify`,
  };

  const certificatePages = await appendCertificate(document, manifest, seal, auditRows);

  setSealedMetadata(document, envelope, manifestDigest);

  const bytes = Buffer.from(await document.save({ useObjectStreams: false }));

  return {
    bytes,
    sha256: sha256Hex(bytes),
    contentSha256,
    manifest,
    manifestDigest,
    signature,
    certificatePages,
  };
}

/**
 * Strip anything in the source document that could still behave like software.
 *
 * A signed agreement that can pop a dialog, submit a form or run script when opened is a
 * liability. Existing interactive fields are flattened into static appearances so the visible
 * content is frozen; if a malformed form resists flattening, the form dictionary is removed
 * outright, which achieves the same end result of nothing being editable.
 */
function neutraliseActiveContent(document: PDFDocument): void {
  try {
    const form = document.getForm();
    if (form.getFields().length > 0) {
      form.flatten({ updateFieldAppearances: true });
    }
  } catch {
    try {
      document.catalog.delete(PDFName.of('AcroForm'));
    } catch {
      // Nothing more can be done here, and the drawn content is still authoritative.
    }
  }

  try {
    document.catalog.delete(PDFName.of('OpenAction'));
    document.catalog.delete(PDFName.of('AA'));
    const names = document.catalog.lookup(PDFName.of('Names'), PDFDict);
    names?.delete(PDFName.of('JavaScript'));
    names?.delete(PDFName.of('EmbeddedFiles'));
  } catch {
    // Absent entries are the common case and are not an error.
  }
}

function setSealedMetadata(document: PDFDocument, envelope: EnvelopeDoc, digest: string): void {
  document.setTitle(sanitizeForPdf(envelope.title));
  document.setSubject(
    sanitizeForPdf(`Sealed agreement, envelope ${envelope._id.toHexString()} version ${envelope.version}`),
  );
  document.setProducer(`${env().APP_NAME} sealing pipeline`);
  document.setCreator(env().APP_NAME);
  document.setKeywords([`signet-envelope:${envelope._id.toHexString()}`, `signet-manifest:${digest}`]);
  document.setModificationDate(new Date());
}

/* ------------------------------------------------------------------ *
 * Stamping field values
 * ------------------------------------------------------------------ */

type StampFonts = { regular: PDFFont };

async function stampFields(
  document: PDFDocument,
  envelope: EnvelopeDoc,
  fonts: StampFonts,
): Promise<void> {
  const pages = document.getPages();

  // Images are fetched once per storage key. A recipient normally has one signature reused
  // across many fields, so this turns N storage reads into one.
  const imageCache = new Map<string, PDFImage>();

  const loadImage = async (key: string): Promise<PDFImage> => {
    const cached = imageCache.get(key);
    if (cached) return cached;
    try {
      const bytes = await storage().get(key);
      const image = await document.embedPng(bytes);
      imageCache.set(key, image);
      return image;
    } catch (error) {
      throw new Error('A collected signature image could not be loaded for sealing.', { cause: error });
    }
  };

  for (const field of envelope.fields) {
    if (field.value === null || field.value === '') continue;

    const page = pages[field.page - 1];
    const geometry = envelope.document.pages[field.page - 1];
    if (!page || !geometry) {
      throw new Error(`Field ${field.id} refers to a page outside the source document.`);
    }

    const placed = placeRect(field, geometry);

    switch (field.type) {
      case 'signature':
      case 'initials': {
        const image = await loadImage(field.value);
        drawImageContained(page, image, placed);
        break;
      }
      case 'checkbox':
        if (field.value === 'true') drawCheck(page, placed);
        break;
      case 'text':
      case 'date':
        drawFieldText(page, placed, fonts.regular, field);
        break;
    }
  }
}

/**
 * Draw an image inside a placed rectangle without distorting it.
 *
 * A signature squashed to fill a box looks forged. The image keeps its aspect ratio and is
 * centred in the field, with a small inset so the ink does not touch the edges of a printed
 * line on the page.
 */
function drawImageContained(page: PDFPage, image: PDFImage, placed: PlacedRect): void {
  const inset = Math.min(placed.width, placed.height) * 0.06;
  const boxWidth = Math.max(placed.width - inset * 2, 1);
  const boxHeight = Math.max(placed.height - inset * 2, 1);

  const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
  const width = image.width * scale;
  const height = image.height * scale;

  const [x, y] = localOffset(
    placed,
    inset + (boxWidth - width) / 2,
    inset + (boxHeight - height) / 2,
  );

  page.drawImage(image, { x, y, width, height, rotate: degrees(placed.rotation) });
}

function drawFieldText(
  page: PDFPage,
  placed: PlacedRect,
  font: PDFFont,
  field: FieldDoc,
): void {
  const value = sanitizeForPdf(field.value ?? '');
  if (!value) return;

  const paddingX = Math.min(3, placed.width * 0.05);
  const available = Math.max(placed.width - paddingX * 2, 1);

  // Start from the size chosen during placement and shrink until the value fits, so a long
  // answer stays inside its box instead of overprinting neighbouring content.
  let size = Math.min(field.fontSize, placed.height * 0.78);
  while (size > 5 && font.widthOfTextAtSize(value, size) > available) {
    size -= 0.25;
  }

  const text =
    font.widthOfTextAtSize(value, size) > available
      ? truncateToWidth(value, available, (candidate) => font.widthOfTextAtSize(candidate, size))
      : value;

  const textHeight = font.heightAtSize(size, { descender: false });
  const [x, y] = localOffset(placed, paddingX, (placed.height - textHeight) / 2);

  page.drawText(text, {
    x,
    y,
    size,
    font,
    color: rgb(0.05, 0.07, 0.12),
    rotate: degrees(placed.rotation),
  });
}

/**
 * Draw a check mark from two line segments.
 *
 * Using geometry rather than a dingbat glyph keeps the mark independent of font encoding, so
 * it renders identically in every reader and cannot be affected by a font substitution.
 */
function drawCheck(page: PDFPage, placed: PlacedRect): void {
  const size = Math.min(placed.width, placed.height);
  const thickness = Math.max(size * 0.12, 0.8);
  const originX = (placed.width - size) / 2;
  const originY = (placed.height - size) / 2;

  const point = (fx: number, fy: number) =>
    localOffset(placed, originX + size * fx, originY + size * fy);

  const [ax, ay] = point(0.18, 0.5);
  const [bx, by] = point(0.42, 0.24);
  const [cx, cy] = point(0.84, 0.74);
  const ink = rgb(0.05, 0.07, 0.12);

  page.drawLine({ start: { x: ax, y: ay }, end: { x: bx, y: by }, thickness, color: ink });
  page.drawLine({ start: { x: bx, y: by }, end: { x: cx, y: cy }, thickness, color: ink });
}

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

function buildManifest(
  envelope: EnvelopeDoc,
  auditEventCount: number,
  auditChainHead: string,
  contentSha256: string,
): CertificateManifest {
  return {
    product: env().APP_NAME,
    envelopeId: envelope._id.toHexString(),
    versionGroupId: envelope.versionGroupId.toHexString(),
    version: envelope.version,
    title: envelope.title,
    owner: { name: envelope.ownerName, email: envelope.ownerEmail },
    originalSha256: envelope.document.sha256,
    contentSha256,
    pageCount: envelope.document.pageCount,
    signingOrder: envelope.signingOrder,
    createdAt: envelope.createdAt.toISOString(),
    sentAt: envelope.sentAt?.toISOString() ?? null,
    completedAt: envelope.completedAt?.toISOString() ?? null,
    approvedAt: envelope.distribution.approvedAt?.toISOString() ?? null,
    sealedAt: new Date().toISOString(),
    auditChainHead,
    auditEventCount,
    signers: envelope.recipients.map((recipient) => ({
      name: recipient.name,
      email: recipient.email,
      role: recipient.isOwner ? 'Sender and signer' : 'Signer',
      status: recipient.status,
      signedAt: recipient.signedAt?.toISOString() ?? null,
      declinedAt: recipient.declinedAt?.toISOString() ?? null,
      declineReason: recipient.declineReason,
      ip: recipient.lastIp,
      userAgent: recipient.lastUserAgent,
      signatureType: recipient.consent?.signatureType ?? null,
      consentAt: recipient.consent?.agreedAt.toISOString() ?? null,
      consentText: recipient.consent?.text ?? null,
      otpVerifiedAt: recipient.otp.verifiedAt?.toISOString() ?? null,
    })),
  };
}

/** Included so the manifest built here and the one checked by /verify cannot drift apart. */
export { buildManifest as buildSealManifest };

/** Re-export for callers that need the exact geometry helper used during stamping. */
export type { PageGeometry };
