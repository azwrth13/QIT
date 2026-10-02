import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LobbyError, CODE_ALPHABET, parseLobbyCode } from '../src/lib/lobby/model';

const { getSteamId, createLobby, joinLobby, leaveLobby, pollLobby, editLobby } = vi.hoisted(() => ({
  getSteamId: vi.fn(), createLobby: vi.fn(), joinLobby: vi.fn(), leaveLobby: vi.fn(), pollLobby: vi.fn(), editLobby: vi.fn(),
}));
vi.mock('../src/lib/auth', () => ({ getSteamId }));
vi.mock('../src/lib/lobby/service', () => ({ createLobby, joinLobby, leaveLobby, pollLobby, editLobby }));
vi.mock('../src/lib/base-url', () => ({ getBaseUrl: () => 'https://qit.example' }));
import { POST as create } from '../src/app/api/lobby/route';
import { POST as join } from '../src/app/api/lobby/[code]/join/route';
import { GET as poll, PATCH as edit, DELETE as leave } from '../src/app/api/lobby/[code]/route';

const context = { params: Promise.resolve({ code: 'K7QX2M' }) };
const me = '76561198000000001';
const request = (method = 'POST', suffix = '', body?: unknown, origin = 'https://qit.example') => new Request(`https://qit.example/api/lobby/K7QX2M${suffix}`, {
  method, headers: { origin, 'x-forwarded-for': '198.51.100.1, 203.0.113.1, 203.0.113.2' },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
});
beforeEach(() => {
  [getSteamId, createLobby, joinLobby, leaveLobby, pollLobby, editLobby].forEach(mock => mock.mockReset());
  getSteamId.mockResolvedValue(me);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('lobby routes', () => {
  it('requires Steam sign-in on every endpoint before service calls', async () => {
    getSteamId.mockResolvedValue(null);
    const responses = await Promise.all([create(request()), join(request(), context), leave(request('DELETE'), context), edit(request('PATCH', '', { state: 'ready' }), context), poll(request('GET'), context)]);
    expect(responses.map(r => r.status)).toEqual([401, 401, 401, 401, 401]);
    [createLobby, joinLobby, leaveLobby, pollLobby, editLobby].forEach(mock => expect(mock).not.toHaveBeenCalled());
  });

  it('requires same origin for all mutations', async () => {
    const req = (method: string, body?: unknown) => request(method, '', body, 'https://evil.example');
    const responses = await Promise.all([create(req('POST')), join(req('POST'), context), leave(req('DELETE'), context), edit(req('PATCH', { state: 'ready' }), context)]);
    expect(responses.map(r => r.status)).toEqual([403, 403, 403, 403]);
    [createLobby, joinLobby, leaveLobby, editLobby].forEach(mock => expect(mock).not.toHaveBeenCalled());
  });

  it('returns a share link from getBaseUrl and passes authenticated identity and trusted IP', async () => {
    const lobby = { code: 'K7QX2M', version: 1 };
    createLobby.mockResolvedValue(lobby); joinLobby.mockResolvedValue(lobby);
    const created = await create(request());
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ lobby, url: 'https://qit.example/lobby/K7QX2M' });
    expect(createLobby).toHaveBeenCalledWith(me);
    expect((await join(request(), context)).status).toBe(200);
    expect(joinLobby).toHaveBeenCalledWith('K7QX2M', me, '203.0.113.1');
  });

  it.each([create, (req: Request) => join(req, context)])('returns rate limits with Retry-After', async handler => {
    createLobby.mockRejectedValue(new LobbyError('rate_limited', 'Too many requests.', 429, 12));
    joinLobby.mockRejectedValue(new LobbyError('rate_limited', 'Too many requests.', 429, 12));
    const response = await handler(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('12');
    expect(await response.json()).toEqual({ error: { code: 'rate_limited', message: 'Too many requests.' } });
  });

  it('returns an empty 304 for an unchanged version, otherwise the lobby', async () => {
    pollLobby.mockResolvedValueOnce(null).mockResolvedValueOnce({ code: 'K7QX2M', version: 3 });
    const unchanged = await poll(request('GET', '?since=2'), context);
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    expect(unchanged.headers.get('cache-control')).toBe('private, no-store');
    expect(pollLobby).toHaveBeenCalledWith('K7QX2M', 2);
    expect(await (await poll(request('GET'), context)).json()).toEqual({ lobby: { code: 'K7QX2M', version: 3 } });
    expect(pollLobby).toHaveBeenLastCalledWith('K7QX2M', undefined);
  });

  it.each(['', '-1', '1.2', 'no', '9007199254740992'])('rejects invalid polling version %s', async since => {
    expect((await poll(request('GET', `?since=${since}`), context)).status).toBe(400);
    expect(pollLobby).not.toHaveBeenCalled();
  });

  it.each(['{', 'null', '[]', '{}', '{"state":"bad"}', '{"state":"ready","filters":[]}', '{"filters":null}'])('rejects bad edits %s', async body => {
    expect((await edit(request('PATCH', '', body), context)).status).toBe(400);
    expect(editLobby).not.toHaveBeenCalled();
  });

  it('caps edit payloads, delegates valid edits and leaves, and returns service errors', async () => {
    expect((await edit(request('PATCH', '', 'a'.repeat(9000)), context)).status).toBe(413);
    editLobby.mockResolvedValue({ version: 4 }); leaveLobby.mockResolvedValue({ version: 5 });
    expect((await edit(request('PATCH', '', { filters: [] }), context)).status).toBe(200);
    expect(editLobby).toHaveBeenCalledWith('K7QX2M', me, { filters: [] });
    expect((await leave(request('DELETE'), context)).status).toBe(200);
    expect(leaveLobby).toHaveBeenCalledWith('K7QX2M', me);
    joinLobby.mockRejectedValue(new LobbyError('full', 'Lobby full.', 409));
    expect((await join(request(), context)).status).toBe(409);
    pollLobby.mockRejectedValue(new Error('secret'));
    const response = await poll(request('GET'), context);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain('secret');
  });
});

it('accepts lowercase codes, excludes ambiguous symbols and rejects malformed codes', () => {
  expect(parseLobbyCode('k7qx2m')).toBe('K7QX2M');
  expect(CODE_ALPHABET).not.toMatch(/[01ILO]/);
  for (const value of ['AAAAA', 'AAAAAAA', 'ABCI23', '../ABC', '000000', null]) expect(parseLobbyCode(value)).toBeNull();
});
