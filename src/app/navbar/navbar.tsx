'use client';

import Link from 'next/link';
import Image from 'next/image';
import { ComputerIcon as SteamIcon } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useFetchUserProfile } from './hooks/useFetchUserProfile';
import LogoutConfirmModal from './components/LogoutConfirmModal';

export default function Navbar() {
  const { profile, loading } = useFetchUserProfile();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) menuRef.current.removeAttribute('open');
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);
  const logout = async () => {
    setIsLoggingOut(true);
    try {
      const response = await fetch('/api/auth/steam-logout', { method: 'POST' });
      if (!response.ok) throw new Error('Could not sign out');
      sessionStorage.removeItem('qit-profile');
      window.location.assign('/');
    } catch {
      setIsLoggingOut(false);
      setShowLogoutConfirm(false);
    }
  };
  return <>
    <LogoutConfirmModal isOpen={showLogoutConfirm} onConfirm={logout} onCancel={() => setShowLogoutConfirm(false)} userName={profile?.personaName} />
    <header className="bg-neobrutal-yellow border-b-4 border-black sticky top-0 z-40">
      <div className="container mx-auto px-4 min-h-16 py-2 flex flex-wrap items-center justify-between gap-2">
        <Link href="/" className="text-xl font-pixel font-bold text-black">QIT</Link>
        <nav aria-label="Main navigation" className="flex flex-wrap items-center justify-end gap-2 sm:gap-4">
          <Link href="/" className="font-bold text-black hover:underline">Home</Link>
          <Link href="/library" className="font-bold text-black hover:underline">Library</Link>
          {loading ? <span className="text-black text-sm">Loading...</span> : profile ?
            <details ref={menuRef} className="relative" onKeyDown={event => { if (event.key === 'Escape') { menuRef.current?.removeAttribute('open'); menuRef.current?.querySelector('summary')?.focus(); } }}>
              <summary aria-label="Profile menu" className="cursor-pointer list-none border-2 border-black bg-white p-1">
                <Image src={profile.avatarFull} alt="" width={32} height={32} unoptimized />
              </summary>
              <div className="absolute right-0 top-full mt-2 w-56 bg-white border-4 border-black shadow-neobrutal p-3 z-50 text-black">
                <p className="font-bold text-sm">Signed in as</p>
                <p className="font-bold break-words mb-3">{profile.personaName}</p>
                <button className="w-full text-left bg-neobrutal-pink border-2 border-black p-2 font-bold text-black" onClick={() => { menuRef.current?.removeAttribute('open'); setShowLogoutConfirm(true); }}>Log Out</button>
              </div>
            </details> :
            <a href="/api/auth/steam-login" className="flex items-center gap-2 bg-neobrutal-blue border-4 border-black shadow-neobrutal px-2 sm:px-4 py-2 font-bold text-black hover:bg-neobrutal-green"><SteamIcon className="w-5 h-5" /><span>Sign In with Steam</span></a>}
        </nav>
      </div>
    </header>
    {isLoggingOut && <span role="status" className="sr-only">Signing out</span>}
  </>;
}
