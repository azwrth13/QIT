import { getSteamId } from '@/lib/auth';
import LobbyStart from './LobbyStart';

export const dynamic = 'force-dynamic';

export default async function LobbyStartPage() {
  const steamId = await getSteamId();
  return <main className="container mx-auto p-8 text-black">
    <h1 className="text-3xl font-bold">Game Night Lobby</h1>
    <p className="my-4">Create a lobby or enter a friend’s six-character code.</p>
    <LobbyStart signedIn={!!steamId} />
  </main>;
}
