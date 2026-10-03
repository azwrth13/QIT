import { getSteamId } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { FriendNight } from './FriendNight';

export default async function FriendNightPage() {
  const steamId = await getSteamId();
  if (!steamId) redirect('/api/auth/steam-login?next=%2Ffriend-night');
  return <FriendNight steamId={steamId} />;
}
