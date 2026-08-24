import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from '@cantoo/pdf-lib';
import { sanitizeForPdf, truncateToWidth, wrapText } from '@/lib/pdf/text';

/**
 * The signing certificate.
 *
 * This is the fourth trust pillar made visible. A sealed document is only as believable as the
 * evidence travelling with it, so the certificate is appended to the document itself rather
 * than offered as a separate file that can be lost. It records who signed, exactly when, from
 * what address, in what order, what wording they agreed to, and the fingerprints that let a
 * third party check the file has not been altered since.
 *
 * Everything here is laid out by hand against the standard PDF fonts. No web view is
 * screenshotted and no font is embedded, so the certificate renders identically in any reader,
 * on any platform, indefinitely.
 */

export type CertificateSigner = {
  name: string;
  email: string;
  role: string;
  status: string;
  signedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  ip: string | null;
  userAgent: string | null;
  signatureType: string | null;
  consentAt: string | null;
  consentText: string | null;
  otpVerifiedAt: string | null;
};

export type CertificateAuditRow = {
  seq: number;
  at: string;
  type: string;
  actor: string;
  ip: string;
  hash: string;
};

export type CertificateManifest = {
  product: string;
  envelopeId: string;
  versionGroupId: string;
  version: number;
  title: string;
  owner: { name: string; email: string };
  originalSha256: string;
  pageCount: number;
  signingOrder: string;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
  approvedAt: string | null;
  sealedAt: string;
  signers: CertificateSigner[];
  auditChainHead: string;
  auditEventCount: number;
};

export type SealBlock = {
  manifestDigest: string;
  signature: string;
  publicKey: string;
  verifyUrl: string;
};

/* ------------------------------------------------------------------ *
 * Page and typography constants
 * ------------------------------------------------------------------ */

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const INK = rgb(0.07, 0.09, 0.13);
const MUTED = rgb(0.42, 0.46, 0.53);
const LINE = rgb(0.85, 0.87, 0.9);
const ACCENT = rgb(0.11, 0.32, 0.85);
const SOFT = rgb(0.96, 0.97, 0.99);
const SUCCESS = rgb(0.05, 0.45, 0.28);
const DANGER = rgb(0.63, 0.11, 0.15);

type Fonts = { regular: PDFFont; bold: PDFFont; mono: PDFFont };

/**
 * A minimal flowing layout engine.
 *
 * The certificate is the only place in the product that needs multi page flow, and the shape
 * of the content is known, so a full layout library would be a large dependency for a small
 * job. The cursor moves down the page and `reserve` starts a new page when the next block will
 * not fit.
 */
class Layout {
  private readonly pages: PDFPage[] = [];
  private cursor = 0;
  page!: PDFPage;

  constructor(private readonly document: PDFDocument, private readonly fonts: Fonts) {
    this.newPage();
  }

  private newPage(): void {
    this.page = this.document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    // Certificate pages are always upright regardless of how the source document was rotated.
    this.page.setRotation(degrees(0));
    this.pages.push(this.page);
    this.cursor = PAGE_HEIGHT - MARGIN;
  }

  /** Ensure `height` points are available, starting a new page if not. */
  reserve(height: number): void {
    if (this.cursor - height < MARGIN + 28) this.newPage();
  }

  get y(): number {
    return this.cursor;
  }

  advance(height: number): void {
    this.cursor -= height;
  }

  text(
    value: string,
    options: { size?: number; font?: PDFFont; color?: RGB; x?: number; y?: number },
  ): void {
    this.page.drawText(sanitizeForPdf(value), {
      x: options.x ?? MARGIN,
      y: options.y ?? this.cursor,
      size: options.size ?? 9,
      font: options.font ?? this.fonts.regular,
      color: options.color ?? INK,
    });
  }

  rule(color: RGB = LINE): void {
    this.page.drawLine({
      start: { x: MARGIN, y: this.cursor },
      end: { x: PAGE_WIDTH - MARGIN, y: this.cursor },
      thickness: 0.75,
      color,
    });
  }

  /** Stamp "Page n of m" on every page once the total is known. */
  finish(subtitle: string): void {
    this.pages.forEach((page, index) => {
      page.drawText(sanitizeForPdf(subtitle), {
        x: MARGIN,
        y: MARGIN - 22,
        size: 7,
        font: this.fonts.regular,
        color: MUTED,
      });
      const label = `Page ${index + 1} of ${this.pages.length}`;
      const width = this.fonts.regular.widthOfTextAtSize(label, 7);
      page.drawText(label, {
        x: PAGE_WIDTH - MARGIN - width,
        y: MARGIN - 22,
        size: 7,
        font: this.fonts.regular,
        color: MUTED,
      });
    });
  }

  get pageCount(): number {
    return this.pages.length;
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * Append the signing certificate to an existing document.
 *
 * Returns the number of pages added so the caller can record how the final artifact is
 * composed.
 */
export async function appendCertificate(
  document: PDFDocument,
  manifest: CertificateManifest,
  seal: SealBlock,
  audit: CertificateAuditRow[],
): Promise<number> {
  const fonts: Fonts = {
    regular: await document.embedFont(StandardFonts.Helvetica),
    bold: await document.embedFont(StandardFonts.HelveticaBold),
    mono: await document.embedFont(StandardFonts.Courier),
  };

  const layout = new Layout(document, fonts);

  drawHeader(layout, fonts, manifest);
  drawDocumentSummary(layout, fonts, manifest);
  drawSigners(layout, fonts, manifest);
  drawAuditTable(layout, fonts, audit);
  drawSeal(layout, fonts, manifest, seal);

  layout.finish(
    `${manifest.product} signing certificate for envelope ${manifest.envelopeId} (version ${manifest.version})`,
  );

  return layout.pageCount;
}

function drawHeader(layout: Layout, fonts: Fonts, manifest: CertificateManifest): void {
  layout.page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - 96,
    width: PAGE_WIDTH,
    height: 96,
    color: SOFT,
  });
  layout.page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - 96,
    width: 4,
    height: 96,
    color: ACCENT,
  });

  layout.advance(4);
  layout.text('SIGNING CERTIFICATE', { size: 17, font: fonts.bold, y: PAGE_HEIGHT - 44 });
  layout.text(
    `Issued by ${manifest.product} at ${formatTimestamp(manifest.sealedAt)}`,
    { size: 8.5, color: MUTED, y: PAGE_HEIGHT - 60 },
  );
  layout.text(
    'This page is part of the sealed document. It records the evidence of signing.',
    { size: 8.5, color: MUTED, y: PAGE_HEIGHT - 74 },
  );

  layout.advance(120);
}

function drawSectionTitle(layout: Layout, fonts: Fonts, title: string): void {
  layout.reserve(40);
  layout.text(title.toUpperCase(), { size: 9, font: fonts.bold, color: ACCENT });
  layout.advance(6);
  layout.rule();
  layout.advance(16);
}

function drawKeyValueRows(
  layout: Layout,
  fonts: Fonts,
  rows: Array<[string, string]>,
): void {
  const labelWidth = 150;
  for (const [label, value] of rows) {
    const lines = wrapText(sanitizeForPdf(value), CONTENT_WIDTH - labelWidth, (text) =>
      fonts.regular.widthOfTextAtSize(text, 9),
    );
    layout.reserve(lines.length * 12 + 4);
    layout.text(label, { size: 9, color: MUTED });
    lines.forEach((line, index) => {
      layout.text(line, {
        size: 9,
        font: fonts.regular,
        x: MARGIN + labelWidth,
        y: layout.y - index * 12,
      });
    });
    layout.advance(Math.max(lines.length, 1) * 12 + 2);
  }
  layout.advance(10);
}

function drawDocumentSummary(layout: Layout, fonts: Fonts, manifest: CertificateManifest): void {
  drawSectionTitle(layout, fonts, 'Document');
  drawKeyValueRows(layout, fonts, [
    ['Title', manifest.title],
    ['Envelope reference', manifest.envelopeId],
    ['Agreement reference', `${manifest.versionGroupId} (version ${manifest.version})`],
    ['Sender', `${manifest.owner.name} <${manifest.owner.email}>`],
    ['Source pages', String(manifest.pageCount)],
    ['Signing order', manifest.signingOrder === 'sequential' ? 'Sequential' : 'Parallel'],
    ['Created', formatTimestamp(manifest.createdAt)],
    ['Sent for signature', formatTimestamp(manifest.sentAt)],
    ['All signatures collected', formatTimestamp(manifest.completedAt)],
    ['Distribution approved by sender', formatTimestamp(manifest.approvedAt)],
    ['Original document SHA-256', chunkHash(manifest.originalSha256)],
  ]);
}

function drawSigners(layout: Layout, fonts: Fonts, manifest: CertificateManifest): void {
  drawSectionTitle(layout, fonts, `Parties (${manifest.signers.length})`);

  for (const signer of manifest.signers) {
    const consentLines = signer.consentText
      ? wrapText(sanitizeForPdf(signer.consentText), CONTENT_WIDTH - 24, (text) =>
          fonts.regular.widthOfTextAtSize(text, 7.5),
        )
      : [];

    const blockHeight = 92 + consentLines.length * 10 + (signer.declineReason ? 22 : 0);
    layout.reserve(blockHeight + 12);

    const top = layout.y;
    layout.page.drawRectangle({
      x: MARGIN,
      y: top - blockHeight,
      width: CONTENT_WIDTH,
      height: blockHeight,
      color: SOFT,
      borderColor: LINE,
      borderWidth: 0.5,
    });

    const signed = signer.status === 'signed';
    layout.text(`${signer.name}`, { size: 11, font: fonts.bold, x: MARGIN + 12, y: top - 20 });
    layout.text(signer.email, { size: 8.5, color: MUTED, x: MARGIN + 12, y: top - 33 });

    const statusLabel = signed
      ? 'SIGNED'
      : signer.status === 'declined'
        ? 'DECLINED'
        : signer.status.toUpperCase();
    const statusWidth = fonts.bold.widthOfTextAtSize(statusLabel, 8);
    layout.text(statusLabel, {
      size: 8,
      font: fonts.bold,
      color: signed ? SUCCESS : signer.status === 'declined' ? DANGER : MUTED,
      x: PAGE_WIDTH - MARGIN - 12 - statusWidth,
      y: top - 20,
    });
    layout.text(signer.role, {
      size: 8,
      color: MUTED,
      x: PAGE_WIDTH - MARGIN - 12 - fonts.regular.widthOfTextAtSize(signer.role, 8),
      y: top - 33,
    });

    const detail: Array<[string, string]> = [
      ['Identity verified by passcode', formatTimestamp(signer.otpVerifiedAt)],
      ['Signed at', formatTimestamp(signer.signedAt)],
      ['IP address', signer.ip ?? 'not recorded'],
      ['Signature captured as', signer.signatureType ?? 'not applicable'],
    ];

    detail.forEach(([label, value], index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = MARGIN + 12 + column * (CONTENT_WIDTH / 2 - 12);
      const y = top - 52 - row * 20;
      layout.text(label, { size: 7, color: MUTED, x, y });
      layout.text(truncateToWidth(value, CONTENT_WIDTH / 2 - 24, (t) => fonts.regular.widthOfTextAtSize(t, 8.5)), {
        size: 8.5,
        x,
        y: y - 10,
      });
    });

    let offset = top - 96;

    if (signer.declineReason) {
      layout.text('Reason for declining', { size: 7, color: MUTED, x: MARGIN + 12, y: offset });
      layout.text(
        truncateToWidth(signer.declineReason, CONTENT_WIDTH - 24, (t) =>
          fonts.regular.widthOfTextAtSize(t, 8),
        ),
        { size: 8, color: DANGER, x: MARGIN + 12, y: offset - 11 },
      );
      offset -= 22;
    }

    if (consentLines.length) {
      layout.text('Statement of intent agreed to by this signer', {
        size: 7,
        color: MUTED,
        x: MARGIN + 12,
        y: offset,
      });
      consentLines.forEach((line, index) => {
        layout.text(line, { size: 7.5, x: MARGIN + 12, y: offset - 11 - index * 10 });
      });
    }

    layout.advance(blockHeight + 12);
  }

  layout.advance(4);
}

function drawAuditTable(layout: Layout, fonts: Fonts, audit: CertificateAuditRow[]): void {
  drawSectionTitle(layout, fonts, `Audit trail (${audit.length} events)`);

  const columns: Array<{ label: string; width: number }> = [
    { label: '#', width: 22 },
    { label: 'Timestamp (UTC)', width: 118 },
    { label: 'Event', width: 138 },
    { label: 'Actor', width: 152 },
    { label: 'IP', width: 74 },
  ];

  const drawHeaderRow = () => {
    layout.reserve(22);
    let x = MARGIN;
    for (const column of columns) {
      layout.text(column.label, { size: 7, font: fonts.bold, color: MUTED, x });
      x += column.width;
    }
    layout.advance(8);
    layout.rule();
    layout.advance(12);
  };

  drawHeaderRow();

  for (const row of audit) {
    if (layout.y - 14 < MARGIN + 28) {
      layout.reserve(1000); // Force a page break, then repeat the header on the new page.
      drawHeaderRow();
    }

    const values = [
      String(row.seq),
      formatTimestamp(row.at),
      humanEvent(row.type),
      row.actor,
      row.ip,
    ];

    let x = MARGIN;
    values.forEach((value, index) => {
      const column = columns[index]!;
      layout.text(
        truncateToWidth(value, column.width - 6, (text) => fonts.regular.widthOfTextAtSize(text, 7.5)),
        { size: 7.5, x },
      );
      x += column.width;
    });
    layout.advance(13);
  }

  layout.advance(10);
}

function drawSeal(
  layout: Layout,
  fonts: Fonts,
  manifest: CertificateManifest,
  seal: SealBlock,
): void {
  drawSectionTitle(layout, fonts, 'Tamper evident seal');

  const intro =
    'The values below bind this certificate to the exact bytes of the document it is attached to and to the ' +
    'audit trail above. Any later edit to any page changes the file, which changes its fingerprint, which no ' +
    'longer matches the record held by the issuer. The signature is an Ed25519 signature over the evidence ' +
    'manifest and can be checked by anyone holding the issuer public key printed here.';

  const introLines = wrapText(intro, CONTENT_WIDTH, (text) =>
    fonts.regular.widthOfTextAtSize(text, 8),
  );
  layout.reserve(introLines.length * 11 + 10);
  introLines.forEach((line, index) => {
    layout.text(line, { size: 8, color: MUTED, y: layout.y - index * 11 });
  });
  layout.advance(introLines.length * 11 + 12);

  drawMonoBlock(layout, fonts, 'Audit chain head', manifest.auditChainHead);
  drawMonoBlock(layout, fonts, 'Evidence manifest digest (SHA-256)', seal.manifestDigest);
  drawMonoBlock(layout, fonts, 'Issuer signature (Ed25519, base64)', seal.signature);
  drawMonoBlock(layout, fonts, 'Issuer public key (SPKI, base64)', seal.publicKey);

  layout.reserve(30);
  layout.text('Verify this document at', { size: 7, color: MUTED });
  layout.advance(11);
  layout.text(seal.verifyUrl, { size: 8.5, font: fonts.bold, color: ACCENT });
  layout.advance(20);
}

function drawMonoBlock(layout: Layout, fonts: Fonts, label: string, value: string): void {
  const lines = wrapText(chunkHash(value), CONTENT_WIDTH - 16, (text) =>
    fonts.mono.widthOfTextAtSize(text, 7.5),
  );
  const height = lines.length * 10 + 14;

  layout.reserve(height + 18);
  layout.text(label, { size: 7, color: MUTED });
  layout.advance(11);

  const top = layout.y;
  layout.page.drawRectangle({
    x: MARGIN,
    y: top - height + 4,
    width: CONTENT_WIDTH,
    height,
    color: SOFT,
    borderColor: LINE,
    borderWidth: 0.5,
  });
  lines.forEach((line, index) => {
    layout.text(line, { size: 7.5, font: fonts.mono, x: MARGIN + 8, y: top - 8 - index * 10 });
  });

  layout.advance(height + 8);
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

/** Group a long hex or base64 value so a human can read it back character by character. */
function chunkHash(value: string): string {
  return (value.match(/.{1,8}/g) ?? [value]).join(' ');
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'not applicable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'not applicable';
  return `${date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')} UTC`;
}

const EVENT_LABELS: Record<string, string> = {
  'envelope.created': 'Envelope created',
  'envelope.document_uploaded': 'Document uploaded',
  'envelope.fields_updated': 'Fields placed',
  'envelope.recipients_updated': 'Recipients set',
  'envelope.sent': 'Sent for signature',
  'envelope.reminder_sent': 'Reminder sent',
  'envelope.voided': 'Envelope voided',
  'envelope.expired': 'Envelope expired',
  'envelope.completed': 'All signatures collected',
  'envelope.approved': 'Distribution approved',
  'envelope.distributed': 'Sealed copy distributed',
  'envelope.superseded': 'Superseded by new version',
  'envelope.reissued': 'Reissued as new version',
  'envelope.sealed': 'Document sealed',
  'recipient.invited': 'Invitation sent',
  'recipient.link_opened': 'Signing link opened',
  'recipient.otp_sent': 'Passcode sent',
  'recipient.otp_failed': 'Passcode attempt failed',
  'recipient.otp_verified': 'Identity verified',
  'recipient.document_viewed': 'Document viewed',
  'recipient.fields_saved': 'Field values saved',
  'recipient.consented': 'Intent to sign confirmed',
  'recipient.signed': 'Signature applied',
  'recipient.declined': 'Declined to sign',
  'document.downloaded': 'Sealed copy downloaded',
};

function humanEvent(type: string): string {
  return EVENT_LABELS[type] ?? type;
}
