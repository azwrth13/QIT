'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseLobbyCode } from '@/lib/lobby/model';

export default function LobbyStart({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/lobby', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? 'Could not create lobby.');
      router.push(`/lobby/${result.lobby.code}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create lobby.'); }
    finally { setBusy(false); }
  }
  return <>
    {signedIn ? <button disabled={busy} className="border-4 border-black bg-neobrutal-blue px-4 py-2 disabled:opacity-50" onClick={() => void create()}>Create lobby</button>
      : <a href="/api/auth/steam-login" className="underline">Sign in with Steam to create a lobby</a>}
    <form className="my-6 flex flex-wrap gap-3" onSubmit={event => {
      event.preventDefault();
      const parsed = parseLobbyCode(code.trim());
      if (!parsed) { setError('Enter a six-character lobby code.'); return; }
      router.push(`/lobby/${parsed}`);
    }}>
      <label>Lobby code <input className="border-2 border-black px-2 py-1 uppercase" value={code} maxLength={6} autoComplete="off" onChange={event => setCode(event.target.value)} /></label>
      <button className="border-2 border-black px-3 py-1" type="submit">Open lobby</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </>;
}
