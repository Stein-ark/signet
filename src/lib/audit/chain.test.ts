import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, computeHash, verifyChain } from '@/lib/audit/chain';
import type { AuditEventDoc, AuditEventType } from '@/lib/models/types';

const envelopeId = new ObjectId();
const versionGroupId = new ObjectId();

function buildChain(types: AuditEventType[]): AuditEventDoc[] {
  const events: AuditEventDoc[] = [];
  let prevHash = GENESIS_HASH;
  types.forEach((type, index) => {
    const withoutHash = {
      envelopeId,
      versionGroupId,
      seq: index + 1,
      type,
      actorType: 'owner' as const,
      actorId: 'owner-1',
      actorEmail: 'owner@example.com',
      actorName: 'Owner',
      at: new Date(Date.UTC(2026, 0, 1, 12, index)),
      ip: '203.0.113.7',
      userAgent: 'test',
      meta: { index },
      prevHash,
    };
    const event = { _id: new ObjectId(), ...withoutHash, hash: computeHash(withoutHash) };
    events.push(event);
    prevHash = event.hash;
  });
  return events;
}

describe('audit hash chain', () => {
  const types: AuditEventType[] = ['envelope.created', 'envelope.sent', 'recipient.signed', 'envelope.completed'];

  it('verifies an untouched chain and reports its head', () => {
    const events = buildChain(types);
    expect(verifyChain(events)).toEqual({
      valid: true,
      head: events.at(-1)!.hash,
      eventCount: 4,
      brokenAt: null,
    });
  });

  it('verifies an empty chain at the genesis hash', () => {
    expect(verifyChain([])).toMatchObject({ valid: true, head: GENESIS_HASH });
  });

  it('detects an edited event even when its own hash is left alone', () => {
    const events = buildChain(types);
    events[1] = { ...events[1]!, meta: { index: 99 } };
    expect(verifyChain(events)).toMatchObject({ valid: false, brokenAt: 2 });
  });

  it('detects an edited event whose hash was recomputed, at the next link', () => {
    const events = buildChain(types);
    const forged = { ...events[1]!, actorEmail: 'attacker@example.com' };
    forged.hash = computeHash(forged);
    events[1] = forged;
    expect(verifyChain(events)).toMatchObject({ valid: false, brokenAt: 3 });
  });

  it('detects a deleted event', () => {
    const events = buildChain(types);
    events.splice(1, 1);
    expect(verifyChain(events)).toMatchObject({ valid: false, brokenAt: 3 });
  });

  it('detects reordered events', () => {
    const events = buildChain(types);
    [events[1], events[2]] = [events[2]!, events[1]!];
    expect(verifyChain(events).valid).toBe(false);
  });

  it('hashes independently of object key order', () => {
    const [event] = buildChain(['envelope.created']);
    const { _id, hash, ...rest } = event!;
    const reversed = Object.fromEntries(Object.entries(rest).reverse()) as typeof rest;
    expect(computeHash(reversed)).toBe(hash);
  });
});
