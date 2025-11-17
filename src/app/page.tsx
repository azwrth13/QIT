'use client';

import { useState, FormEvent } from 'react';
import { SearchIcon, Loader2, ExternalLink, User } from 'lucide-react';
import Image from 'next/image';
import BrowserWindow from './components/BrowserWindow';

interface SteamProfile {
  steamId: string;
  personaName: string;
  profileUrl: string;
  avatarFull: string;
  avatarMedium: string;
}

export default function Home() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<SteamProfile | null>(null);

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    
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
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Steam ID or Profile URL (e.g., 76561198000000000 or steamcommunity.com/id/username)"
                className="w-full py-3 px-4 pr-12 border-4 border-black bg-white text-black placeholder-gray-500 focus:outline-none focus:bg-neobrutal-yellow font-bold"
                disabled={loading}
              />
              {loading ? (
                <Loader2 className="absolute right-4 top-1/2 transform -translate-y-1/2 text-black animate-spin w-5 h-5" />
              ) : (
                <SearchIcon className="absolute right-4 top-1/2 transform -translate-y-1/2 text-black w-5 h-5" />
              )}
            </div>
          </form>

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
                  href={`/library?steamid=${profile.steamId}`}
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
                </div>
              </div>
              
              {/* Enhanced Sign In with Cost Information */}
              <div className="bg-neobrutal-purple border-4 border-black shadow-neobrutal p-6 max-w-2xl mx-auto">
                <h4 className="font-bold text-black text-xl mb-4">Sign In with Steam</h4>
                <p className="text-sm text-black font-bold mb-4">
                  Connect your Steam account to access your game library and start randomizing!
                </p>
                
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
                      <strong>~30 seconds</strong> - Quick Steam sign-in, instant library access
                    </p>
                  </div>
                  
                  {/* Privacy */}
                  <div className="bg-white border-2 border-black p-3">
                    <h5 className="font-bold text-black text-sm mb-1">🔒 Privacy</h5>
                    <p className="text-xs text-black font-bold">
                      <strong>Secure OpenID</strong> - Only public profile & game library accessed
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
                    <strong>What we access:</strong> Your public Steam profile (username, avatar) and game library. 
                    We do NOT access messages, friends list, payment info, or any private data.
                  </p>
                </div>
              </div>
            </div>
          )}
        </BrowserWindow>
      </div>
    </div>
  );
}
