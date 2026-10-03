import { getSteamId } from '@/lib/auth';
import BacklogView from './BacklogView';

export const dynamic = 'force-dynamic';

export default async function BacklogPage() {
  const steamId = await getSteamId();
  return (
    <main className="container mx-auto max-w-5xl p-6 text-black md:p-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold sm:text-4xl">Backlog Discovery</h1>
        <p className="mt-2 text-base text-zinc-700 sm:text-lg">
          Surface the forgotten and untouched games you already purchased on Steam.
        </p>
      </header>
      {steamId ? (
        <BacklogView />
      ) : (
        <div className="border-4 border-black bg-white p-6 shadow-neobrutal">
          <p className="text-lg font-bold">Sign in with Steam to explore your backlog.</p>
          <a
            className="mt-4 inline-block border-4 border-black bg-neobrutal-yellow px-6 py-2 font-bold shadow-neobrutal hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none"
            href="/api/auth/steam-login"
          >
            Sign in with Steam
          </a>
        </div>
      )}
    </main>
  );
}
