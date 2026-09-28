import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientIpFromForwardedFor } from '../src/lib/client-ip';

const headers = (values: Record<string, string>) => new Headers(values);

afterEach(() => vi.unstubAllEnvs());

describe('clientIpFromForwardedFor', () => {
  it('uses the entry two hops from the right by default', () => {
    expect(clientIpFromForwardedFor(headers({ 'x-forwarded-for': '203.0.113.1' }))).toBe('203.0.113.1');
    expect(clientIpFromForwardedFor(headers({ 'x-forwarded-for': '203.0.113.1, 35.191.0.1' }))).toBe('203.0.113.1');
    expect(clientIpFromForwardedFor(headers({ 'x-forwarded-for': '198.51.100.9, 203.0.113.1, 35.191.0.1' }))).toBe('203.0.113.1');
  });
  it('honours TRUSTED_PROXY_HOPS and ignores invalid values', () => {
    const forwarded = headers({ 'x-forwarded-for': '198.51.100.9, 203.0.113.1, 35.191.0.1' });
    vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
    expect(clientIpFromForwardedFor(forwarded)).toBe('35.191.0.1');
    vi.stubEnv('TRUSTED_PROXY_HOPS', '3');
    expect(clientIpFromForwardedFor(forwarded)).toBe('198.51.100.9');
    vi.stubEnv('TRUSTED_PROXY_HOPS', 'zero');
    expect(clientIpFromForwardedFor(forwarded)).toBe('203.0.113.1');
  });
  it('falls back to X-Real-IP, then unknown, when the header is absent or empty', () => {
    expect(clientIpFromForwardedFor(headers({ 'x-forwarded-for': ' ', 'x-real-ip': '203.0.113.2' }))).toBe('203.0.113.2');
    expect(clientIpFromForwardedFor(headers({ 'x-real-ip': '203.0.113.2' }))).toBe('203.0.113.2');
    expect(clientIpFromForwardedFor(headers({}))).toBe('unknown');
  });
});
