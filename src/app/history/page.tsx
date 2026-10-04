import { getSteamId } from '@/lib/auth';
import HistoryView from './HistoryView';

export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  const steamId = await getSteamId();

  return (
    <main className="container mx-auto max-w-5xl p-6 text-black md:p-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold">Recommendation History</h1>
        <p className="mt-2 text-base text-gray-700">
          Track games QIT has recommended for you, re-roll old sessions, adjust your anti-repeat window, and see which recommendations became played games.
        </p>
      </header>

      {steamId ? (
        <HistoryView />
      ) : (
        <div className="border-4 border-black bg-white p-6 shadow-[4px_4px_0_0_#000]">
          <p className="text-lg font-bold">Sign in with Steam to see your QIT recommendation history.</p>
          <a
            href="/api/auth/steam-login"
            className="mt-4 inline-block border-2 border-black bg-neobrutal-yellow px-4 py-2 font-bold shadow-[2px_2px_0_0_#000]"
          >
            Sign in with Steam
          </a>
        </div>
      )}
    </main>
  );
}
