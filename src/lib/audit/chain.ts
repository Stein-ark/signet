import { ObjectId } from 'mongodb';
import { auditEvents, type AuditEventDoc, type AuditEventType } from '@/lib/models/types';
import { canonicalJson, sha256Hex } from '@/lib/util/crypto';

/**
 * The audit trail.
 *
 * Every event is chained to the one before it: the hash of an event covers its own contents
 * plus the hash of its predecessor. That turns the collection into an append only ledger. An
 * attacker with write access to the database can still change a row, but they cannot do it
 * invisibly, because every later hash in that envelope's chain stops matching and the head no
 * longer matches the value printed on the sealed certificate.
 *
 * The chain is per envelope. That keeps verification cheap (an auditor only replays the events
 * for the document in front of them) and means one envelope's history cannot be invalidated by
 * unrelated activity elsewhere in the system.
 */

const GENESIS = '0'.repeat(64);
const MAX_APPEND_ATTEMPTS = 5;

export type AuditInput = {
  envelopeId: ObjectId;
  versionGroupId: ObjectId;
  type: AuditEventType;
  actorType: 'owner' | 'recipient' | 'system';
  actorId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  ip: string;
  userAgent: string;
  meta?: Record<string, unknown>;
};

/** The exact payload the hash covers. Kept separate so verification cannot drift from writing. */
function chainPayload(event: Omit<AuditEventDoc, '_id' | 'hash'>): string {
  return canonicalJson({
    envelopeId: event.envelopeId.toHexString(),
    versionGroupId: event.versionGroupId.toHexString(),
    seq: event.seq,
    type: event.type,
    actorType: event.actorType,
    actorId: event.actorId,
    actorEmail: event.actorEmail,
    actorName: event.actorName,
    at: event.at.toISOString(),
    ip: event.ip,
    userAgent: event.userAgent,
    meta: event.meta,
    prevHash: event.prevHash,
  });
}

export function computeHash(event: Omit<AuditEventDoc, '_id' | 'hash'>): string {
  return sha256Hex(event.prevHash + chainPayload(event));
}

/**
 * Append one event to an envelope's chain.
 *
 * Sequence numbers are allocated optimistically: read the current head, write the next
 * position, and let the unique index on (envelopeId, seq) reject a collision. On collision we
 * re read and try again. This is correct under concurrency without needing a transaction or a
 * separate counter document, and collisions are rare because a single envelope is not a hot
 * write path.
 */
export async function recordEvent(input: AuditInput): Promise<AuditEventDoc> {
  const collection = await auditEvents();

  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const head = await collection.findOne(
      { envelopeId: input.envelopeId },
      { sort: { seq: -1 }, projection: { seq: 1, hash: 1 } },
    );

    const withoutHash: Omit<AuditEventDoc, '_id' | 'hash'> = {
      envelopeId: input.envelopeId,
      versionGroupId: input.versionGroupId,
      seq: (head?.seq ?? 0) + 1,
      type: input.type,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      actorEmail: input.actorEmail ?? null,
      actorName: input.actorName ?? null,
      at: new Date(),
      ip: input.ip,
      userAgent: input.userAgent,
      meta: input.meta ?? {},
      prevHash: head?.hash ?? GENESIS,
    };

    const event: AuditEventDoc = {
      _id: new ObjectId(),
      ...withoutHash,
      hash: computeHash(withoutHash),
    };

    try {
      await collection.insertOne(event);
      return event;
    } catch (error) {
      const isDuplicate =
        typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
      if (!isDuplicate || attempt === MAX_APPEND_ATTEMPTS - 1) throw error;
      // Another writer took this sequence number. Back off briefly and recompute from the new
      // head so the chain stays a single unbroken line.
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }

  throw new Error('Could not append to the audit trail.');
}

/** Read a whole chain in order. */
export async function readChain(envelopeId: ObjectId): Promise<AuditEventDoc[]> {
  const collection = await auditEvents();
  return collection.find({ envelopeId }, { sort: { seq: 1 } }).toArray();
}

export type ChainVerification = {
  valid: boolean;
  head: string;
  eventCount: number;
  /** Sequence number of the first event that does not match, when the chain is broken. */
  brokenAt: number | null;
};

/**
 * Replay a chain and confirm every link.
 *
 * Exposed to owners in the audit view and used by the public verification page, because a
 * tamper evident log is only worth something if somebody actually checks it.
 */
export function verifyChain(events: AuditEventDoc[]): ChainVerification {
  let previous = GENESIS;

  for (const [index, event] of events.entries()) {
    const expectedSeq = index + 1;
    const recomputed = computeHash({ ...event, prevHash: previous });

    if (event.seq !== expectedSeq || event.prevHash !== previous || event.hash !== recomputed) {
      return { valid: false, head: previous, eventCount: events.length, brokenAt: event.seq };
    }
    previous = event.hash;
  }

  return { valid: true, head: previous, eventCount: events.length, brokenAt: null };
}

export const GENESIS_HASH = GENESIS;
