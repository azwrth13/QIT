import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealData } from 'iron-session';
import { createSession, SESSION_TTL, verifySession } from '../src/lib/session';
import { getAchievementProgress, isSteamId, logServerError, OPENID_ENDPOINT, OPENID_NAMESPACE, parseSteamSearch, steamApiUrl, validateOpenId } from '../src/lib/steam';
import { MAX_GENRE_APPIDS, validateAppIds } from '../src/lib/genres';

const steamId = '76561198000000000';
const secret = 'test-only-secret-with-at-least-32-characters';
const returnTo = 'https://qit.example/api/auth/steam-callback';
function assertion() {
  return new URLSearchParams({
    'openid.ns': OPENID_NAMESPACE,
    'openid.mode': 'id_res',
    'openid.op_endpoint': OPENID_ENDPOINT,
    'openid.return_to': returnTo,
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${steamId}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${steamId}`,
    'openid.signed': 'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.response_nonce': '2026-01-01T00:00:00Znonce',
    'openid.assoc_handle': 'handle',
    'openid.sig': 'signature',
  });
}

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('encrypted authenticated sessions', () => {
  beforeEach(() => vi.stubEnv('SESSION_SECRET', secret));
  it('round trips a valid identity without exposing it', async () => {
    const token = await createSession(steamId);
    expect(token).not.toContain(steamId);
    expect(await verifySession(token)).toBe(steamId);
  });
  it('rejects forged, missing, raw, and tampered cookies', async () => {
    const token = await createSession(steamId);
    for (const bad of [undefined, steamId, JSON.stringify({ steamId }), token.slice(0, -10) + 'tampering!']) {
      expect(await verifySession(bad)).toBeNull();
    }
  });
  it('rejects a token signed with a different secret', async () => {
    const token = await createSession(steamId);
    vi.stubEnv('SESSION_SECRET', 'a-different-secret-with-at-least-32-characters');
    expect(await verifySession(token)).toBeNull();
  });
  it('expires sessions', async () => {
    vi.useFakeTimers();
    const token = await createSession(steamId);
    vi.setSystemTime(Date.now() + SESSION_TTL * 1000 + 1);
    expect(await verifySession(token)).toBeNull();
  });
  it('rejects invalid identities and invalid sealed payloads', async () => {
    await expect(createSession('123')).rejects.toThrow('Invalid Steam ID');
    for (const payload of [{ steamId: '123', expiresAt: Date.now() + 10000 }, { steamId }, { steamId, expiresAt: 'never' }]) {
      const token = await sealData(payload, { password: secret, ttl: SESSION_TTL });
      expect(await verifySession(token)).toBeNull();
    }
  });
  it('fails closed when the secret is missing or too short', async () => {
    for (const value of ['', 'short']) {
      vi.stubEnv('SESSION_SECRET', value);
      await expect(createSession(steamId)).rejects.toThrow('SESSION_SECRET');
      await expect(verifySession('token')).rejects.toThrow('SESSION_SECRET');
    }
  });
});

describe('Steam inputs and URLs', () => {
  it('accepts exactly 17 ASCII digits', () => {
    expect(isSteamId(steamId)).toBe(true);
    for (const invalid of [null, 76561198000000000, '', '123', steamId + '0', ' ' + steamId, steamId + '\n', steamId + '&key=other', '７６５６１１９８０００００００００']) {
      expect(isSteamId(invalid)).toBe(false);
    }
  });
  it('parses only supported exact Steam profile hosts and valid IDs', () => {
    expect(parseSteamSearch(steamId)).toEqual({ steamId });
    expect(parseSteamSearch(`https://steamcommunity.com/profiles/${steamId}/`)).toEqual({ steamId });
    expect(parseSteamSearch('https://steamcommunity.com/id/my-name')).toEqual({ vanity: 'my-name' });
    expect(parseSteamSearch(' my_name ')).toEqual({ vanity: 'my_name' });
    for (const invalid of ['https://evil.example/steamcommunity.com/profiles/' + steamId, 'https://steamcommunity.com.evil.example/id/name', 'https://steamcommunity.com/profiles/123', 'https://steamcommunity.com/id/name?key=other']) {
      expect(parseSteamSearch(invalid)).toBeNull();
    }
  });
  it('encodes API parameters and rejects invalid IDs before requests', () => {
    vi.stubEnv('STEAM_API_KEY', 'test-key');
    const url = steamApiUrl('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: 'name&key=injected' });
    expect(url.searchParams.getAll('key')).toEqual(['test-key']);
    expect(url.searchParams.get('vanityurl')).toBe('name&key=injected');
    expect(() => steamApiUrl('/test', { steamid: '123&key=injected' })).toThrow('Invalid Steam ID');
  });
  it('treats Steam no-stats and private responses as no achievement progress', async () => {
    vi.stubEnv('STEAM_API_KEY', 'test-key');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(Response.json({ playerstats: { success: false, error: 'Requested app has no stats' } }, { status: 400 }));
    expect(await getAchievementProgress(steamId, 10)).toBeNull();
    fetchMock.mockResolvedValueOnce(Response.json({ playerstats: { success: false, error: 'Profile is not public' } }, { status: 403 }));
    expect(await getAchievementProgress(steamId, 10)).toBeNull();
    fetchMock.mockResolvedValueOnce(Response.json({ playerstats: { success: true, achievements: [{ achieved: 1 }, { achieved: 0 }, { achieved: 1 }] } }));
    expect(await getAchievementProgress(steamId, 10)).toEqual({ unlocked: 2, total: 3, percent: 67 });
    for (const status of [429, 500]) {
      fetchMock.mockResolvedValueOnce(new Response('', { status }));
      await expect(getAchievementProgress(steamId, 10)).rejects.toThrow('Steam request failed');
    }
  });
  it('logs only safe error metadata', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('https://steam.example/?key=secret');
    logServerError('Steam request failed', error);
    expect(log).toHaveBeenCalledWith('Steam request failed', { name: 'Error' });
    error.name = 'secret';
    logServerError('Steam request failed', error);
    expect(log).toHaveBeenLastCalledWith('Steam request failed', { name: 'Error' });
  });
});

describe('OpenID callback validation', () => {
  it('accepts a Steam assertion addressed to this callback', () => {
    expect(validateOpenId(assertion(), returnTo)).toBe(steamId);
  });
  it.each([
    ['openid.return_to', 'https://another.example/api/auth/steam-callback'],
    ['openid.op_endpoint', 'https://evil.example/openid/login'],
    ['openid.claimed_id', `https://evil.example/openid/id/${steamId}`],
    ['openid.claimed_id', 'https://steamcommunity.com/openid/id/123'],
    ['openid.claimed_id', `https://steamcommunity.com/openid/id/${steamId}/extra`],
    ['openid.identity', 'https://steamcommunity.com/openid/id/76561198000000001'],
    ['openid.ns', 'bad-namespace'], ['openid.mode', 'cancel'],
    ['openid.signed', 'identity,claimed_id'],
  ])('rejects altered %s', (key, value) => {
    const params = assertion(); params.set(key, value);
    expect(validateOpenId(params, returnTo)).toBeNull();
  });
  it.each(['openid.return_to', 'openid.op_endpoint', 'openid.claimed_id', 'openid.identity', 'openid.ns', 'openid.mode', 'openid.signed'])('rejects missing %s', key => {
    const params = assertion(); params.delete(key);
    expect(validateOpenId(params, returnTo)).toBeNull();
  });
  it.each(['openid.claimed_id', 'openid.return_to', 'openid.mode', 'openid.sig', 'openid.extra'])('rejects duplicate %s even with identical values', key => {
    const params = assertion(); params.set(key, 'value'); params.append(key, 'value');
    expect(validateOpenId(params, returnTo)).toBeNull();
  });
});

describe('genre request bounds', () => {
  it('accepts a bounded unique integer list', () => expect(validateAppIds({ appids: [10, 20] })).toEqual([10, 20]));
  it.each([null, {}, { appids: [] }, { appids: [1, 1] }, { appids: ['1'] }, { appids: [1.5] }, { appids: [-1] }, { appids: [0] }, { appids: [Number.MAX_SAFE_INTEGER] }, { appids: Array.from({ length: MAX_GENRE_APPIDS + 1 }, (_, i) => i + 1) }])('rejects malformed or excessive input', body => {
    expect(validateAppIds(body)).toBeNull();
  });
});
