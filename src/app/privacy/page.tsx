import { getSteamId } from '@/lib/auth';
import { DATA_DISCLOSURE } from '@/lib/privacy/disclosure';
import DataControls from './DataControls';

export const metadata = { title: 'Privacy and data controls | QIT' };
export const dynamic = 'force-dynamic';

export default async function PrivacyPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const signedIn = !!await getSteamId();
  const deleted = (await searchParams).deleted === '1';
  return <article className="container mx-auto max-w-4xl px-4 py-10 space-y-8">
    <h1 className="text-3xl font-bold">Privacy and your QIT data</h1>
    <p>Effective October 2, 2026. QIT uses Steam sign-in and Steam data to help you choose games, find shared games and track your QIT activity. QIT receives your Steam identity, not your Steam password. Steam data is retrieved when you request features such as sign-in, library sync, friends, achievements or joining a lobby. Steam privacy settings still apply; signing in does not unlock private game details.</p>
    <section className="space-y-3"><h2 className="text-2xl font-bold">Where data is stored and who can see it</h2>
      <p>QIT stores application data in Google Cloud Firestore in us-central1 (Iowa, United States). Server routes access Firestore; direct browser access to the database is denied. Steam provides the source data, and Google/Firebase provides hosting and storage. Your browser also requests Steam-hosted images and follows Steam links, which can send request information to those providers.</p>
      <p>Public library pages can show a Steam user’s public library. For group and lobby features, the intended disclosure is the intersection of selected libraries and individual players’ playtime, rather than a friend’s whole library. Lobby members opt in by joining while signed in; anyone with a lobby code can currently see member names and avatars. The current single-friend library API returns a public friend’s library to the signed-in requester so the browser can calculate shared games. This is broader than the intended group-only disclosure.</p>
    </section>
    <section className="space-y-4"><h2 className="text-2xl font-bold">What QIT stores and for how long</h2>
      <p>Cache durations below describe how long data may be used before refreshing. They do not promise physical erasure at the expiry time. Most account records have no automatic age-based deletion.</p>
      {DATA_DISCLOSURE.map(item => <div key={item.name} className="border-4 border-black bg-white p-4 space-y-2"><h3 className="text-lg font-bold">{item.name}</h3><p>{item.data}</p><p>{item.retention}</p></div>)}
    </section>
    <section className="space-y-3"><h2 className="text-2xl font-bold">Export or delete my data</h2>
      {deleted && !signedIn && <p role="status">Your QIT data was deleted and this browser was signed out.</p>}
      <DataControls signedIn={signedIn} />
      <p>Deletion does not change your Steam account or remove shared game metadata. Your Steam ID or public profile information may still appear in other users’ saved activity, friend snapshots or pinned lists. Public data may be fetched again when someone requests it. Signing in again creates a new QIT profile.</p>
      <p>The export is a read of current records, not an atomic snapshot. Stop ongoing syncs or other QIT actions before deleting; concurrent actions or another signed-in browser can write new records. Deletion clears this browser’s cookie; previously copied session cookies and other browsers expire on their existing schedule. Infrastructure logs and backups are outside this account-data action; their retention settings are not documented in this repository.</p>
    </section>
  </article>;
}
