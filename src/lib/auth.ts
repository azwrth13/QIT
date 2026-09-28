import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from './session';

export async function getSteamId(): Promise<string | null> {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}
