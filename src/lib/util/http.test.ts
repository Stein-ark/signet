import { describe, expect, it } from 'vitest';
import { UNKNOWN_IP, clientIp } from '@/lib/util/http';

const headers = (forwarded?: string) =>
  new Headers(forwarded === undefined ? {} : { 'x-forwarded-for': forwarded });

describe('client IP from the trusted proxy chain', () => {
  it('takes the entry appended by the nearest trusted proxy', () => {
    expect(clientIp(headers('198.51.100.9'), 1)).toBe('198.51.100.9');
  });

  it('ignores addresses the client prepended itself', () => {
    // The client sent "X-Forwarded-For: 1.2.3.4" hoping to pick its own IP.
    expect(clientIp(headers('1.2.3.4, 198.51.100.9'), 1)).toBe('198.51.100.9');
  });

  it('counts back across several trusted proxies', () => {
    expect(clientIp(headers('1.2.3.4, 198.51.100.9, 10.0.0.2'), 2)).toBe('198.51.100.9');
  });

  it('ignores forwarding headers entirely when no proxy is trusted', () => {
    expect(clientIp(headers('198.51.100.9'), 0)).toBe(UNKNOWN_IP);
  });

  it('reports unknown when the chain is shorter than the configured proxies', () => {
    expect(clientIp(headers('198.51.100.9'), 2)).toBe(UNKNOWN_IP);
    expect(clientIp(headers(), 1)).toBe(UNKNOWN_IP);
  });
});
