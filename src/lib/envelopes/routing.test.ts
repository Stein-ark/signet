import { describe, expect, it } from 'vitest';
import { recipientsUpNext } from '@/lib/envelopes/routing';
import type { RecipientDoc, RecipientStatus } from '@/lib/models/types';

function recipient(id: string, routingOrder: number, status: RecipientStatus): RecipientDoc {
  return { id, routingOrder, status } as RecipientDoc;
}

const ids = (list: RecipientDoc[]) => list.map((item) => item.id);

describe('who can sign next', () => {
  it('lets every waiting recipient act in parallel routing', () => {
    const recipients = [recipient('a', 1, 'signed'), recipient('b', 2, 'invited'), recipient('c', 3, 'verified')];
    expect(ids(recipientsUpNext({ signingOrder: 'parallel', recipients }))).toEqual(['b', 'c']);
  });

  it('only lets the lowest unsigned routing order act in sequential routing', () => {
    const recipients = [recipient('a', 1, 'signed'), recipient('b', 2, 'invited'), recipient('c', 3, 'invited')];
    expect(ids(recipientsUpNext({ signingOrder: 'sequential', recipients }))).toEqual(['b']);
  });

  it('treats recipients sharing a routing order as one group', () => {
    const recipients = [recipient('a', 1, 'invited'), recipient('b', 1, 'signed'), recipient('c', 2, 'invited')];
    expect(ids(recipientsUpNext({ signingOrder: 'sequential', recipients }))).toEqual(['a']);
  });

  it('returns nobody once everyone has signed', () => {
    const recipients = [recipient('a', 1, 'signed'), recipient('b', 2, 'signed')];
    expect(recipientsUpNext({ signingOrder: 'sequential', recipients })).toEqual([]);
  });

  it('never offers a declined recipient', () => {
    const recipients = [recipient('a', 1, 'declined'), recipient('b', 1, 'invited')];
    expect(ids(recipientsUpNext({ signingOrder: 'parallel', recipients }))).toEqual(['b']);
  });
});
