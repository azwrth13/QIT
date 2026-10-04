import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/firestore';
import { paths } from '../src/lib/store/paths';
import { getAntiRepeatDays, setAntiRepeatDays, DEFAULT_ANTI_REPEAT_DAYS } from '../src/lib/history/anti-repeat';
import { GET, POST } from '../src/app/api/history/anti-repeat/route';

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ getSteamId: auth }));

const emulated = !!process.env.FIRESTORE_EMULATOR_HOST;
let serial = 0;
const freshUser = () => '7656119955' + String(Date.now() % 100000).padStart(5, '0') + String(serial++ % 100).padStart(2, '0');

describe.skipIf(!emulated)('anti-repeat preference store and API (emulator)', () => {
  let steamId: string;

  beforeEach(async () => {
    steamId = freshUser();
    auth.mockResolvedValue(steamId);
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://qit.test');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns default 30 days when preference document does not exist', async () => {
    const days = await getAntiRepeatDays(steamId);
    expect(days).toBe(DEFAULT_ANTI_REPEAT_DAYS);
  });

  it('persists and retrieves valid anti-repeat values (0, 7, 30, 90)', async () => {
    for (const option of [0, 7, 30, 90]) {
      const saved = await setAntiRepeatDays(steamId, option);
      expect(saved).toBe(option);

      const retrieved = await getAntiRepeatDays(steamId);
      expect(retrieved).toBe(option);

      // Verify Firestore document contents directly
      const doc = await db.doc(paths.antiRepeat(steamId)).get();
      expect(doc.exists).toBe(true);
      expect(doc.get('days')).toBe(option);
      expect(doc.get('updatedAt')).toBeTruthy();
    }
  });

  it('rejects invalid anti-repeat day values', async () => {
    for (const invalid of [1, 14, 45, -1, 100, NaN]) {
      await expect(setAntiRepeatDays(steamId, invalid)).rejects.toThrow(/Anti-repeat window must be one of/);
    }
  });

  it('serves preferences end-to-end through GET and POST route handlers', async () => {
    // Initial GET returns default 30
    const initialRes = await GET(new Request('https://qit.test/api/history/anti-repeat'));
    expect(initialRes.status).toBe(200);
    expect(await initialRes.json()).toEqual({
      days: 30,
      options: [0, 7, 30, 90],
      defaultDays: 30,
    });

    // POST updates setting to 7 days
    const postRes = await POST(new Request('https://qit.test/api/history/anti-repeat', {
      method: 'POST',
      headers: { origin: 'https://qit.test', 'content-type': 'application/json' },
      body: JSON.stringify({ days: 7 }),
    }));
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toEqual({ days: 7 });

    // Subsequent GET returns 7
    const updatedRes = await GET(new Request('https://qit.test/api/history/anti-repeat'));
    expect(updatedRes.status).toBe(200);
    expect((await updatedRes.json()).days).toBe(7);
  });
});
