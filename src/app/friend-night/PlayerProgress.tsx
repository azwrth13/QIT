import type { PlayerState } from '@/lib/friend-night/model';
import type { GroupMemberSignals } from '@/lib/roulette/types';
import { formatPlaytime } from '@/components/result-card/format';

export function IndividualPlaytime({ members, steamId, names }: { members: GroupMemberSignals[]; steamId: string; names: Record<string, string> }) {
  return <section aria-label="Individual playtime"><h2 className="mt-4 font-bold">Individual playtime</h2>
    <ul>{members.map(m => <li key={m.steamId}>{m.steamId === steamId ? 'You' : names[m.steamId] ?? m.steamId}: {m.playtimeForever === null ? 'Unknown / hidden' : formatPlaytime(m.playtimeForever)}</li>)}</ul>
  </section>;
}

export function PlayerProgress({ players, onRemove }: { players: PlayerState[]; onRemove?: (id: string) => void }) {
  return <section aria-label="Selected libraries" aria-live="polite" className="my-4 border-4 border-black bg-white p-4">
    {players.length === 0 && <p>Select at least one friend to build your shared library.</p>}
    <ul>{players.map(player => <li key={player.steamId} className="my-2">
      <strong>{player.name}</strong>: {player.state === 'loading' ? 'Loading library…' : player.state === 'ok' ? `${player.count ?? 0} owned games` : player.state === 'private' ? 'Private library — excluded until you remove this player' : player.state === 'not_found' ? 'Profile not found' : 'Library unavailable — retry loading'}
      {player.state !== 'ok' && player.state !== 'loading' && onRemove && <button className="ml-3 underline" onClick={() => onRemove(player.steamId)}>Remove {player.name} from this group</button>}
    </li>)}</ul>
    {players.some(p => p.state !== 'ok') && players.length > 0 && <p>Every selected library must be accessible before spinning. Remove unavailable players to continue with a smaller group.</p>}
  </section>;
}
