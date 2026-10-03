import { getSteamId } from '@/lib/auth';
import ComparePickerClient from './ComparePickerClient';

export const dynamic = 'force-dynamic';

export default async function CompareRootPage() {
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
            Sign in with your Steam account to compare games and playtimes with any friend or Steam profile.
          </p>
          <a
            href="/api/auth/steam-login?next=/compare"
            className="inline-block border-4 border-black bg-neobrutal-blue px-6 py-3 font-bold shadow-neobrutal hover:translate-x-0.5 hover:translate-y-0.5 text-lg"
          >
            Sign in with Steam
          </a>
        </div>
      </main>
    );
  }

  return <ComparePickerClient currentSteamId={currentSteamId} />;
}
