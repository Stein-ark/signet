import type { Collection, ObjectId } from 'mongodb';
import { ensureIndexes, getDb } from '@/lib/db/mongo';

/**
 * The complete persisted shape of Signet.
 *
 * Recipients and fields are embedded inside the envelope rather than living in their own
 * collections. That choice is deliberate: resolving a signing link, deciding what a recipient
 * may see and advancing the routing order all need the whole signing context at once. Embedded
 * documents make that a single indexed read with no join and no N+1, and they let a signature
 * plus the routing advance happen as one atomic update. The cost is that a single database
 * document contains every recipient's field values, so the read path is guarded by a strict
 * projection layer (see `views.ts`) that is the only sanctioned way to send envelope data to a
 * recipient.
 */

/* ------------------------------------------------------------------ *
 * Users and sessions
 * ------------------------------------------------------------------ */

export type UserDoc = {
  _id: ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
  failedLoginCount: number;
  lockedUntil: Date | null;
};

export type SessionKind = 'owner' | 'signing';

export type SessionDoc = {
  _id: ObjectId;
  kind: SessionKind;
  /** Keyed hash of the cookie value. The raw token is never persisted. */
  tokenHash: string;
  /** Double submit CSRF value, readable by our own scripts and echoed in a header. */
  csrfToken: string;
  /** Set on owner sessions. */
  userId: ObjectId | null;
  /** Set on signing sessions. A signing session is bound to exactly one recipient. */
  envelopeId: ObjectId | null;
  recipientId: string | null;
  ip: string;
  userAgent: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

/* ------------------------------------------------------------------ *
 * Envelopes
 * ------------------------------------------------------------------ */

export const ENVELOPE_STATUSES = [
  'draft',
  'sent',
  'completed',
  'approved',
  'declined',
  'voided',
  'expired',
] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

export const RECIPIENT_STATUSES = [
  'pending',
  'invited',
  'viewed',
  'verified',
  'signed',
  'declined',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const FIELD_TYPES = ['signature', 'initials', 'date', 'text', 'checkbox'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type SigningOrder = 'parallel' | 'sequential';

/** Page geometry captured at upload time, mirroring what pdf.js will render. */
export type PageGeometry = {
  /** [x0, y0, x1, y1] in PDF user space: CropBox clipped to MediaBox and normalized. */
  viewBox: [number, number, number, number];
  /** Display rotation in degrees, always 0, 90, 180 or 270. */
  rotation: number;
  /** Rendered size at zoom 1, after rotation. Convenience for the client. */
  renderedWidth: number;
  renderedHeight: number;
};

export type StoredFile = {
  /** Opaque object storage key. Never derived from user input. */
  key: string;
  /** SHA-256 of the plaintext bytes, hex encoded. */
  sha256: string;
  size: number;
  contentType: string;
};

export type EnvelopeDocumentInfo = StoredFile & {
  filename: string;
  pageCount: number;
  pages: PageGeometry[];
};

export type SealedDocumentInfo = StoredFile & {
  /** Fingerprint of the bytes before the seal block was stamped onto the certificate. */
  contentSha256: string;
  /** Ed25519 signature over the seal manifest, base64. */
  signature: string;
  sealedAt: Date;
};

export type OtpState = {
  hash: string | null;
  expiresAt: Date | null;
  attempts: number;
  sentAt: Date | null;
  resendCount: number;
  /** When this recipient last proved control of their mailbox. Evidence for attribution. */
  verifiedAt: Date | null;
};

export type ConsentRecord = {
  agreedAt: Date;
  /** The exact wording the signer agreed to, stored verbatim as evidence of intent. */
  text: string;
  adoptedName: string;
  signatureType: 'drawn' | 'typed';
};

export type RecipientDoc = {
  id: string;
  email: string;
  name: string;
  /** 1 based. Meaningful for sequential routing; ties are invited together. */
  routingOrder: number;
  /** True for the envelope owner when they included themselves as a signer. */
  isOwner: boolean;
  status: RecipientStatus;

  /** Keyed hash of the signing link token. Null until the envelope is sent. */
  tokenHash: string | null;
  tokenIssuedAt: Date | null;
  tokenExpiresAt: Date | null;

  otp: OtpState;

  consent: ConsentRecord | null;
  /** Storage key of the rendered signature image (PNG). */
  signatureKey: string | null;
  /** Storage key of the rendered initials image (PNG), when initials fields exist. */
  initialsKey: string | null;

  invitedAt: Date | null;
  viewedAt: Date | null;
  signedAt: Date | null;
  declinedAt: Date | null;
  declineReason: string | null;

  remindersSent: number;
  lastReminderAt: Date | null;
  lastIp: string | null;
  lastUserAgent: string | null;
};

export type FieldDoc = {
  id: string;
  recipientId: string;
  /** 1 based page number. */
  page: number;
  type: FieldType;
  /**
   * Rectangle normalized against the rendered page image: fractions of the rendered width and
   * height with the origin at the top left. Zoom independent by construction, and rotation is
   * already baked in because the rendered image is what the owner was looking at.
   */
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  required: boolean;
  label: string;
  fontSize: number;
  maxLength: number;
  /**
   * For text and date fields this is the literal text. For checkbox it is 'true' or 'false'.
   * For signature and initials it is the storage key of the signer's adopted image.
   */
  value: string | null;
  filledAt: Date | null;
};

export type EnvelopeDoc = {
  _id: ObjectId;
  ownerId: ObjectId;
  ownerEmail: string;
  ownerName: string;

  /** Stable across re issues so every version of an agreement shares a history. */
  versionGroupId: ObjectId;
  version: number;
  supersedesId: ObjectId | null;
  supersededById: ObjectId | null;

  title: string;
  message: string;
  status: EnvelopeStatus;
  signingOrder: SigningOrder;
  ownerIsSigner: boolean;
  expiresAt: Date;

  document: EnvelopeDocumentInfo;
  sealed: SealedDocumentInfo | null;

  recipients: RecipientDoc[];
  fields: FieldDoc[];

  distribution: {
    approvedAt: Date | null;
    approvedBy: ObjectId | null;
    deliveredAt: Date | null;
    deliveredTo: string[];
  };

  reminder: {
    intervalHours: number;
    nextAt: Date | null;
    sentCount: number;
  };

  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
  completedAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
};

/* ------------------------------------------------------------------ *
 * Audit trail
 * ------------------------------------------------------------------ */

export const AUDIT_EVENT_TYPES = [
  'envelope.created',
  'envelope.document_uploaded',
  'envelope.fields_updated',
  'envelope.recipients_updated',
  'envelope.sent',
  'envelope.reminder_sent',
  'envelope.voided',
  'envelope.expired',
  'envelope.completed',
  'envelope.approved',
  'envelope.distributed',
  'envelope.superseded',
  'envelope.reissued',
  'envelope.sealed',
  'recipient.invited',
  'recipient.link_opened',
  'recipient.otp_sent',
  'recipient.otp_failed',
  'recipient.otp_verified',
  'recipient.document_viewed',
  'recipient.fields_saved',
  'recipient.consented',
  'recipient.signed',
  'recipient.declined',
  'document.downloaded',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export type AuditEventDoc = {
  _id: ObjectId;
  envelopeId: ObjectId;
  versionGroupId: ObjectId;
  /** Position in the per envelope chain, starting at 1. */
  seq: number;
  type: AuditEventType;
  actorType: 'owner' | 'recipient' | 'system';
  actorId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  at: Date;
  ip: string;
  userAgent: string;
  meta: Record<string, unknown>;
  /** Hash of the previous event in this envelope's chain, or 64 zeros for the first. */
  prevHash: string;
  /** sha256(prevHash + canonicalJson(payload)). Any edit or deletion breaks the chain. */
  hash: string;
};

/* ------------------------------------------------------------------ *
 * Email log and rate limiting
 * ------------------------------------------------------------------ */

export type EmailLogDoc = {
  _id: ObjectId;
  to: string;
  subject: string;
  template: string;
  envelopeId: ObjectId | null;
  provider: string;
  providerMessageId: string | null;
  status: 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
};

export type RateLimitDoc = {
  _id: string;
  count: number;
  expiresAt: Date;
};

/* ------------------------------------------------------------------ *
 * Collection accessors
 * ------------------------------------------------------------------ */

async function collection<T extends { _id: unknown }>(name: string): Promise<Collection<T>> {
  await ensureIndexes();
  const db = await getDb();
  return db.collection<T>(name);
}

export const users = () => collection<UserDoc>('users');
export const sessions = () => collection<SessionDoc>('sessions');
export const envelopes = () => collection<EnvelopeDoc>('envelopes');
export const auditEvents = () => collection<AuditEventDoc>('auditEvents');
export const emailLog = () => collection<EmailLogDoc>('emailLog');
export const rateLimits = () => collection<RateLimitDoc>('rateLimits');
