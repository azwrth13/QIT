import Link from 'next/link';
import { getSteamId } from '@/lib/auth';
import { isSteamId } from '@/lib/steam';
import CompareClient from './CompareClient';

export const dynamic = 'force-dynamic';

export default async function ComparePage({ params }: { params: Promise<{ steamid: string }> }) {
  const { steamid } = await params;
  const currentSteamId = await getSteamId();

  if (!currentSteamId) {
    return (
      <main className="container mx-auto px-4 py-12 text-black max-w-xl">
        <div className="border-4 border-black bg-white p-8 shadow-neobrutal text-center">
          <span className="border-2 border-black bg-neobrutal-yellow px-2 py-0.5 text-xs font-bold uppercase">
            Library Comparison
          </span>
          <h1 className="text-3xl font-bold my-4">Sign in to Compare</h1>
          <p className="mb-6 font-medium">
            Sign in with your Steam account to compare games and playtimes with this player.
          </p>
          <a
            href={`/api/auth/steam-login?next=${encodeURIComponent(`/compare/${steamid}`)}`}
            className="inline-block border-4 border-black bg-neobrutal-blue px-6 py-3 font-bold shadow-neobrutal hover:translate-x-0.5 hover:translate-y-0.5 text-lg"
          >
            Sign in with Steam
          </a>
        </div>
      </main>
    );
  }

  if (!isSteamId(steamid)) {
    return (
      <main className="container mx-auto px-4 py-12 text-black max-w-xl">
        <div className="border-4 border-black bg-neobrutal-pink p-8 shadow-neobrutal">
          <h1 className="text-2xl font-bold mb-2">Invalid Steam ID</h1>
          <p className="font-medium mb-6">
            The profile &quot;{steamid}&quot; is not a valid 17-digit Steam ID.
          </p>
          <Link
            href="/compare"
            className="border-4 border-black bg-white px-4 py-2 font-bold shadow-neobrutal inline-block"
          >
            Try Another Profile
          </Link>
        </div>
      </main>
    );
  }

  return <CompareClient steamid={steamid} currentUserSteamId={currentSteamId} />;
}
