import { NextResponse } from 'next/server';
import { getSteamId } from '@/lib/auth';
import { logServerError } from '@/lib/steam';
import { getStoredProfile } from '@/lib/library-data';

export async function GET() {
  const steamId = await getSteamId();
  if (!steamId) return NextResponse.json({ error: 'Not authenticated. Steam ID is missing.' }, { status: 401 });
  try {
    const profile = await getStoredProfile(steamId);
    if (!profile) return NextResponse.json({ error: 'Profile not found.' }, { status: 404 });
    return NextResponse.json(profile, { headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' } });
  } catch (error) {
    logServerError('Profile lookup failed', error);
    return NextResponse.json({ error: 'Unable to load Steam profile.' }, { status: 502 });
  }
}
