import { getSteamId } from '@/lib/auth';
import ProfileStatsView from './ProfileStatsView';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const steamId = await getSteamId();
  return <main className="container mx-auto max-w-5xl p-6 text-black md:p-8">
    <h1 className="text-3xl font-bold">Your QIT profile</h1>
    <p className="my-4">Discover more of your library. See the games you start and the challenges you finish through QIT.</p>
    {steamId ? <ProfileStatsView /> : <a className="underline" href="/api/auth/steam-login">Sign in with Steam to see your QIT stats</a>}
  </main>;
}
