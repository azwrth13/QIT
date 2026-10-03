'use client';

import { useState } from 'react';

export default function DataControls({ signedIn }: { signedIn: boolean }) {
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [deleted, setDeleted] = useState(false);

  async function perform(action: 'export' | 'delete') {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/user/data/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'delete' ? { confirmation } : {}),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error?.message ?? 'Unable to complete your request. Please retry.');
      }
      if (action === 'export') {
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = 'qit-data.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage('Your JSON export has been downloaded. Keep it somewhere private.');
      } else {
        setDeleted(true);
        // Reload so the navbar also reflects the cleared session.
        window.location.assign('/privacy?deleted=1');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Request failed. Please retry.');
    } finally { setBusy(false); }
  }

  if (!signedIn || deleted) return <p>Sign in with Steam to export or delete your QIT data. <a className="underline font-bold" href="/api/auth/steam-login">Sign in</a></p>;
  return <div className="space-y-4">
    <p>Download your account documents and your own entries in shared caches and lobbies as JSON.</p>
    <button className="border-4 border-black bg-neobrutal-yellow px-4 py-2 font-bold disabled:opacity-50" disabled={busy} onClick={() => perform('export')}>Export my data</button>
    <p>Deletion removes your profile, library, index chunks, achievements, friends snapshot, pinned players, rolls, events, exclusions, challenges and statistics. It removes you from lobbies and clears your shared library cache and this browser’s session. This cannot be undone. Export first if you want a copy.</p>
    <label className="block" htmlFor="delete-confirmation">Type <strong>DELETE MY DATA</strong> to confirm</label>
    <input id="delete-confirmation" className="border-4 border-black p-2 w-full max-w-md" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} autoComplete="off" />
    <button className="block border-4 border-black bg-red-200 px-4 py-2 font-bold disabled:opacity-50" disabled={busy || confirmation !== 'DELETE MY DATA'} onClick={() => perform('delete')}>Delete my data and sign out</button>
    <p role="status" aria-live="polite">{busy ? 'Processing your request…' : message}</p>
  </div>;
}
