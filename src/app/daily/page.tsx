import { getSteamId } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { DailyClient } from './DailyClient';

export default async function DailyPage() {
  if (!await getSteamId()) redirect('/api/auth/steam-login?next=/daily');
  return <DailyClient />;
}
