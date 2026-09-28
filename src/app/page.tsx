'use client';

import { useState, useEffect, useRef, FormEvent, KeyboardEvent } from 'react';
import { SearchIcon, Loader2, ExternalLink, User } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import BrowserWindow from './components/BrowserWindow';
import { useFetchUserProfile } from './navbar/hooks/useFetchUserProfile';

interface SteamProfile {
  steamId: string;
  personaName: string;
  profileUrl: string;
  avatarFull: string;
  avatarMedium: string;
}

export default function Home() {
  const { profile: signedInProfile, loading: authLoading } = useFetchUserProfile();
  const searchRef = useRef<HTMLInputElement>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  useEffect(() => { setLoginError(new URLSearchParams(window.location.search).get('login_error')); }, []);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<SteamProfile | null>(null);
  const [friends, setFriends] = useState<SteamProfile[]>([]);
  const [friendsMessage, setFriendsMessage] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeFriend, setActiveFriend] = useState(-1);

  useEffect(() => {
    if (!signedInProfile) return;
    let cancelled = false;
    fetch('/api/steam/friends', { cache: 'no-store' })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load Steam friends.');
        if (!cancelled) {
          setFriends(data.friends);
          setFriendsMessage(data.message ?? null);
        }
      })
      .catch(() => { if (!cancelled) setFriendsMessage('Could not load Steam friends. Please try again later.'); });
    return () => { cancelled = true; };
  }, [signedInProfile]);

  const matchingFriends = friends.filter(friend => friend.personaName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const chooseFriend = (friend: SteamProfile) => {
    setQuery(friend.steamId);
    setProfile(friend);
    setError(null);
    setSuggestionsOpen(false);
    setActiveFriend(-1);
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && suggestionsOpen) {
      event.preventDefault();
      setSuggestionsOpen(false);
      setActiveFriend(-1);
    } else if (event.key === 'ArrowDown' && matchingFriends.length) {
      event.preventDefault();
      setSuggestionsOpen(true);
      setActiveFriend(index => (index + 1) % matchingFriends.length);
    } else if (event.key === 'ArrowUp' && matchingFriends.length) {
      event.preventDefault();
      setSuggestionsOpen(true);
      setActiveFriend(index => index <= 0 ? matchingFriends.length - 1 : index - 1);
    } else if (event.key === 'Enter' && suggestionsOpen && activeFriend >= 0 && matchingFriends[activeFriend]) {
      event.preventDefault();
      chooseFriend(matchingFriends[activeFriend]);
    }
  };

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    setSuggestionsOpen(false);
    
    if (!query.trim()) {
      setError('Please enter a Steam ID or profile URL');
      return;
    }

    setLoading(true);
    setError(null);
    setProfile(null);

    try {
      const response = await fetch(`/api/steam/search?q=${encodeURIComponent(query)}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to search profile');
      }

      setProfile(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-4rem)] bg-[#FFFEF7] px-4 py-8">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-5xl font-pixel font-bold text-black mb-4">QIT</h1>
        </div>

        {/* Description Section */}
        <div className="mb-8 space-y-4">
          {/* Main Tagline */}
          <div className="bg-neobrutal-yellow border-4 border-black shadow-neobrutal p-6">
            <p className="text-black font-bold text-lg leading-relaxed">
              Discover new games you already own. This Steam game randomizer instantly selects a title from your library so you never waste time deciding what to play.
            </p>
          </div>

          {/* Why use it & What you get */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Why use it */}
            <div className="bg-neobrutal-blue border-4 border-black shadow-neobrutal p-6">
              <h2 className="text-black font-bold text-xl mb-4">Why use it:</h2>
              <ul className="space-y-3">
                <li className="text-black font-bold flex items-start">
                  <span className="mr-2">•</span>
                  <span>Eliminates decision fatigue when your backlog feels overwhelming.</span>
                </li>
                <li className="text-black font-bold flex items-start">
                  <span className="mr-2">•</span>
                  <span>Helps you rediscover hidden gems you forgot you had.</span>
                </li>
                <li className="text-black font-bold flex items-start">
                  <span className="mr-2">•</span>
                  <span>Makes choosing your next game fast, fun, and effortless.</span>
                </li>
              </ul>
            </div>

            {/* What you get */}
            <div className="bg-neobrutal-green border-4 border-black shadow-neobrutal p-6">
              <h2 className="text-black font-bold text-xl mb-4">What you get:</h2>
              <ul className="space-y-3">
                <li className="text-black font-bold flex items-start">
                  <span className="mr-2">•</span>
                  <span>Quick random picks from your Steam library</span>
                </li>
                <li className="text-black font-bold flex items-start">
                  <span className="mr-2">•</span>
                  <span>Fresh gaming experiences without buying anything new</span>
                </li>
                <li className="text-black font-bold flex items-start">
                  <span className="mr-2">•</span>
                  <span>A simple way to enjoy more of the games you already own</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <BrowserWindow title="STEAM PROFILE SEARCH">
          {/* Search Form */}
          <form onSubmit={handleSearch} className="mb-6">
            <div className="relative">
              <input
                ref={searchRef}
                type="text"
                aria-label="Steam ID or profile URL"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={Boolean(signedInProfile && suggestionsOpen && matchingFriends.length)}
                aria-controls={signedInProfile && suggestionsOpen && matchingFriends.length ? 'friend-suggestions' : undefined}
                aria-activedescendant={suggestionsOpen && activeFriend >= 0 && matchingFriends[activeFriend] ? `friend-option-${activeFriend}` : undefined}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setActiveFriend(-1); setSuggestionsOpen(true); }}
                onFocus={() => setSuggestionsOpen(true)}
                onBlur={() => setSuggestionsOpen(false)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Steam ID or Profile URL (e.g., 76561198000000000 or steamcommunity.com/id/username)"
                className="w-full py-3 px-4 pr-12 border-4 border-black bg-white text-black placeholder-gray-500 focus:outline-none focus:bg-neobrutal-yellow font-bold"
                disabled={loading}
              />
              {loading ? (
                <Loader2 className="absolute right-4 top-1/2 transform -translate-y-1/2 text-black animate-spin w-5 h-5" />
              ) : (
                <SearchIcon className="absolute right-4 top-1/2 transform -translate-y-1/2 text-black w-5 h-5" />
              )}
              {signedInProfile && suggestionsOpen && matchingFriends.length > 0 && (
                <div id="friend-suggestions" role="listbox" aria-label="Steam friends" className="absolute z-30 top-full left-0 right-0 mt-1 max-h-64 overflow-y-auto bg-white border-4 border-black shadow-neobrutal">
                  {matchingFriends.map((friend, index) => (
                    <button key={friend.steamId} id={`friend-option-${index}`} type="button" role="option"
                      aria-selected={activeFriend === index}
                      onPointerDown={event => event.preventDefault()}
                      onClick={() => chooseFriend(friend)}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-left text-black font-bold hover:bg-neobrutal-yellow ${activeFriend === index ? 'bg-neobrutal-yellow' : ''}`}>
                      <Image src={friend.avatarMedium} alt="" width={32} height={32} unoptimized />
                      <span>{friend.personaName}</span>
                    </button>
                  ))}
                </div>
              )}
              {signedInProfile && suggestionsOpen && friendsMessage && !matchingFriends.length && <p role="status" className="absolute z-30 top-full left-0 right-0 mt-1 p-3 bg-white border-4 border-black shadow-neobrutal text-sm font-bold text-black">{friendsMessage}</p>}
            </div>
            <button type="submit" disabled={loading} className="mt-3 w-full sm:w-auto flex items-center justify-center gap-2 bg-neobrutal-yellow hover:bg-neobrutal-pink border-4 border-black shadow-neobrutal text-black font-bold py-2 px-5 disabled:opacity-60">
              <SearchIcon className="w-5 h-5" /> Search
            </button>
          </form>

          {!authLoading && signedInProfile && <Link href="/library" className="mb-6 inline-flex items-center gap-2 bg-neobrutal-green hover:bg-neobrutal-purple border-4 border-black shadow-neobrutal text-black font-bold py-2 px-4">My Library</Link>}

          {loginError && <div role="alert" className="mb-6 p-4 bg-neobrutal-pink border-4 border-black text-black font-bold">Steam sign-in failed ({loginError.replaceAll('_', ' ')}). Please try again.</div>}
          {/* Error Message */}
          {error && (
            <div className="mb-6 p-4 bg-neobrutal-pink border-4 border-black shadow-neobrutal">
              <p className="text-black text-sm font-bold">{error}</p>
            </div>
          )}

          {/* Profile Result */}
          {profile && (
            <div className="bg-neobrutal-blue border-4 border-black shadow-neobrutal p-6">
              <div className="flex items-center gap-4 mb-4">
                <div className="relative w-16 h-16 border-4 border-black">
                  <Image
                    src={profile.avatarFull}
                    alt={profile.personaName}
                    fill
                    className="object-cover pixelated"
                    sizes="64px"
                    unoptimized
                  />
                </div>
                <div className="flex-1">
                  <h3 className="text-xl font-bold text-black mb-1">{profile.personaName}</h3>
                  <p className="text-sm text-black font-bold">Steam ID: {profile.steamId}</p>
                </div>
              </div>
              <div className="flex gap-3">
                <a
                  href={profile.profileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 flex items-center justify-center gap-2 bg-neobrutal-green hover:bg-neobrutal-purple border-4 border-black shadow-neobrutal text-black font-bold py-2 px-4 transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  View Profile
                </a>
                <a
                  href={`/library/${profile.steamId}`}
                  className="flex-1 flex items-center justify-center gap-2 bg-neobrutal-yellow hover:bg-neobrutal-pink border-4 border-black shadow-neobrutal text-black font-bold py-2 px-4 transition-colors"
                >
                  <User className="w-4 h-4" />
                  View Library
                </a>
              </div>
            </div>
          )}

          {/* Info Section */}
          {!profile && !loading && !error && (
            <div className="mt-8 space-y-4">
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <div className="bg-neobrutal-green border-4 border-black shadow-neobrutal p-4 max-w-xs">
                  <h4 className="font-bold text-black mb-2">Search Profiles</h4>
                  <p className="text-sm text-black font-bold">
                    Enter a Steam ID or profile URL
                  </p>
                  <button type="button" onClick={() => searchRef.current?.focus()} className="mt-3 bg-white hover:bg-neobrutal-yellow border-2 border-black px-3 py-2 text-black font-bold">Search Profiles</button>
                </div>
              </div>
              
              {/* Enhanced Sign In with Cost Information */}
              {!authLoading && !signedInProfile && <div className="bg-neobrutal-purple border-4 border-black shadow-neobrutal p-6 max-w-2xl mx-auto">
                <h4 className="font-bold text-black text-xl mb-4">Sign In with Steam</h4>
                <p className="text-sm text-black font-bold mb-4">
                  Connect your Steam account to access your game library and start randomizing!
                </p>
                <a href="/api/auth/steam-login" className="inline-flex bg-neobrutal-yellow hover:bg-neobrutal-green border-4 border-black shadow-neobrutal text-black font-bold py-2 px-4">Sign In with Steam</a>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                  {/* Monetary Cost */}
                  <div className="bg-white border-2 border-black p-3">
                    <h5 className="font-bold text-black text-sm mb-1">💰 Cost</h5>
                    <p className="text-xs text-black font-bold">
                      <strong>100% FREE</strong> - No fees, subscriptions, or hidden costs
                    </p>
                  </div>
                  
                  {/* Time Cost */}
                  <div className="bg-white border-2 border-black p-3">
                    <h5 className="font-bold text-black text-sm mb-1">⏱️ Time</h5>
                    <p className="text-xs text-black font-bold">
                      <strong>Quick setup</strong> - Sign in with Steam, then refresh your library
                    </p>
                  </div>
                  
                  {/* Privacy */}
                  <div className="bg-white border-2 border-black p-3">
                    <h5 className="font-bold text-black text-sm mb-1">🔒 Privacy</h5>
                    <p className="text-xs text-black font-bold">
                      <strong>Secure OpenID</strong> - Reads your public profile and game details
                    </p>
                  </div>
                  
                  {/* Cognitive Load */}
                  <div className="bg-white border-2 border-black p-3">
                    <h5 className="font-bold text-black text-sm mb-1">🧠 Easy to Use</h5>
                    <p className="text-xs text-black font-bold">
                      <strong>Simple</strong> - Just sign in, filter, and randomize
                    </p>
                  </div>
                </div>
                
                <div className="mt-4 pt-3 border-t-2 border-black">
                  <p className="text-xs text-black font-bold">
                    <strong>What we access:</strong> Your Steam profile (username and avatar) and the game details Steam makes public. Signed-in libraries are synced to QIT storage; we do not access messages, payment details, or private game details.
                  </p>
                </div>
              </div>}
            </div>
          )}
        </BrowserWindow>
      </div>
    </div>
  );
}
