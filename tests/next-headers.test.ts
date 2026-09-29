import { describe, expect, it } from 'vitest';
import loadCustomRoutes from 'next/dist/lib/load-custom-routes';
import { buildCustomRoute } from 'next/dist/lib/build-custom-route';
import nextConfig from '../next.config';

async function cacheControl(path: string): Promise<string | undefined> {
  const { headers } = await loadCustomRoutes(nextConfig);
  let value: string | undefined;
  for (const route of headers.map(header => buildCustomRoute('header', header))) {
    if (!new RegExp(route.regex).test(path)) continue;
    value = route.headers.find(header => header.key === 'Cache-Control')?.value ?? value;
  }
  return value;
}

describe('Cache-Control header rules', () => {
  it.each(['/', '/library', '/library/76561198000000000', '/_not-found', '/apis'])('forbids edge caching of page %s', async path => {
    expect(await cacheControl(path)).toBe('public, max-age=0, s-maxage=0, must-revalidate');
  });
  it.each(['/api', '/api/games', '/api/auth/steam-callback'])('keeps API route %s private', async path => {
    expect(await cacheControl(path)).toBe('private, no-store');
  });
  it('leaves static assets to Next long-term caching', async () => {
    expect(await cacheControl('/_next/static/chunks/main.js')).toBeUndefined();
  });
});
