import { getSteamId } from '@/lib/auth';
import { parseLobbyCode } from '@/lib/lobby/model';
import { notFound } from 'next/navigation';
import LobbyClient from './LobbyClient';

export const dynamic = 'force-dynamic';

export default async function LobbyPage({ params }: { params: Promise<{ code: string }> }) {
  const code = parseLobbyCode((await params).code);
  if (!code) notFound();
  const steamId = await getSteamId();
  if (!steamId) return <main className="container mx-auto p-8 text-black">
    <h1 className="text-3xl font-bold">Game Night Lobby {code}</h1>
    <p className="my-4">Everyone signs in with Steam to join a game night.</p>
    <a className="inline-block border-4 border-black bg-neobrutal-blue p-3" href={`/api/auth/steam-login?next=${encodeURIComponent(`/lobby/${code}`)}`}>Sign in with Steam</a>
  </main>;
  return <LobbyClient code={code} steamId={steamId} />;
}
