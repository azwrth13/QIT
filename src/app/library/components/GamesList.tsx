// components/GamesList.tsx

'use client';

import { useState, useMemo, memo, useCallback, useEffect } from 'react';
import Image from 'next/image';
import VirtualGameGrid from './VirtualGameGrid';
import { SearchIcon, X, UserX } from 'lucide-react';
import { Game } from "../../../lib/games";
import { MAX_GENRE_APPIDS } from "../../../lib/genres";

interface GameListProps {
  games: Game[];
  onFilteredGamesChange?: (filteredGames: Game[]) => void;
  publicView?: boolean;
}

interface FriendProfile {
  steamId: string;
  personaName: string;
  avatarMedium: string;
}

const GameList = memo(function GameList({ games, onFilteredGamesChange, publicView = false }: GameListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'playtime'>('name');
  const [filterBy, setFilterBy] = useState<'all' | 'played' | 'unplayed'>('all');
  const [selectedGenre, setSelectedGenre] = useState<string>('all');
  const [gamesWithGenres, setGamesWithGenres] = useState<Game[]>(games);
  const [genres, setGenres] = useState<string[]>([]);
  
  // Friend search state
  const [friendSearchQuery, setFriendSearchQuery] = useState('');
  const [searchingFriend, setSearchingFriend] = useState(false);
  const [selectedFriend, setSelectedFriend] = useState<FriendProfile | null>(null);
  const [friendGames, setFriendGames] = useState<Game[]>([]);
  const [friendError, setFriendError] = useState<string | null>(null);

  // Fetch genres for games in small batches so they fill in progressively
  useEffect(() => {
    let isCancelled = false;

    const applyGenres = (genresMap: Record<number, string[]>) => {
      const updatedGames = games.map(game => genresMap[game.appid] ? { ...game, genres: genresMap[game.appid] } : game);
      const allGenres = new Set<string>();
      updatedGames.forEach(game => game.genres?.forEach(genre => allGenres.add(genre)));
      setGamesWithGenres(updatedGames);
      setGenres(Array.from(allGenres).sort());
    };

    const fetchGenres = async () => {
      const genresMap: Record<number, string[]> = {};
      applyGenres(genresMap);
      const appids = publicView ? [] : games.filter(g => !g.genres || g.genres.length === 0).map(g => g.appid);
      let errorCount = 0;
      for (let start = 0; start < appids.length && !isCancelled; start += MAX_GENRE_APPIDS) {
        const batch = appids.slice(start, start + MAX_GENRE_APPIDS);
        try {
          const response = await fetch('/api/games/genres', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appids: batch }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'Unknown error');
          errorCount += data.errorCount || 0;
          Object.assign(genresMap, data.genres || {});
          if (!isCancelled) applyGenres(genresMap);
        } catch (error) {
          errorCount += batch.length;
          if (!isCancelled) console.error('Failed to fetch genres:', error);
        }
      }
      if (errorCount > 0 && !isCancelled) console.warn(`Genres could not be loaded for ${errorCount} games.`);
    };

    fetchGenres();

    // Cleanup function to cancel requests if component unmounts
    return () => {
      isCancelled = true;
    };
  }, [games, publicView]);

  // Search for friend
  const handleFriendSearch = useCallback(async () => {
    if (!friendSearchQuery.trim()) return;

    setSearchingFriend(true);
    setFriendError(null);
    setSelectedFriend(null);
    setFriendGames([]);
    try {
      const response = await fetch(`/api/steam/search?q=${encodeURIComponent(friendSearchQuery)}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to search friend');
      }

      const gamesResponse = await fetch(`/api/games/friend?steamid=${data.steamId}`);
      const gamesData = await gamesResponse.json();
      if (!gamesResponse.ok) throw new Error(gamesData.error || 'Failed to fetch friend games');
      if (!gamesData.games?.length) throw new Error('This friend has no public games. Check their Steam Game details privacy setting.');
      setFriendGames(gamesData.games);
      setSelectedFriend({ steamId: data.steamId, personaName: data.personaName, avatarMedium: data.avatarMedium });
    } catch (error) {
      console.error('Error searching friend:', error);
      setFriendError((error as Error).message || 'Failed to search for friend');
    } finally {
      setSearchingFriend(false);
    }
  }, [friendSearchQuery]);

  const clearFriend = useCallback(() => {
    setSelectedFriend(null);
    setFriendGames([]);
    setFriendSearchQuery('');
    setFriendError(null);
  }, []);

  // Filter and sort games
  const filteredAndSortedGames = useMemo(() => {
    let filtered = gamesWithGenres;

    // Filter by friend's games (common games only)
    if (selectedFriend) {
      const friendAppIds = new Set(friendGames.map(g => g.appid));
      filtered = filtered.filter(game => friendAppIds.has(game.appid));
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      filtered = filtered.filter(game => 
        game.name.toLowerCase().includes(query)
      );
    }

    // Filter by genre
    if (selectedGenre !== 'all') {
      filtered = filtered.filter(game => 
        game.genres && game.genres.includes(selectedGenre)
      );
    }

    // Filter by playtime status
    if (filterBy === 'played') {
      filtered = filtered.filter(game => (game.playtime_forever || 0) > 0);
    } else if (filterBy === 'unplayed') {
      filtered = filtered.filter(game => (game.playtime_forever || 0) === 0);
    }

    // Sort games
    const sorted = [...filtered].sort((a, b) => {
      if (sortBy === 'name') {
        return a.name.localeCompare(b.name);
      } else {
        const playtimeA = a.playtime_forever || 0;
        const playtimeB = b.playtime_forever || 0;
        return playtimeB - playtimeA;
      }
    });

    return sorted;
  }, [gamesWithGenres, selectedFriend, friendGames, searchQuery, selectedGenre, sortBy, filterBy]);

  // Notify parent of filtered games
  useEffect(() => {
    if (onFilteredGamesChange) {
      onFilteredGamesChange(filteredAndSortedGames);
    }
  }, [filteredAndSortedGames, onFilteredGamesChange]);

  return (
    <div className="bg-white border-4 border-black shadow-neobrutal p-4">
      {/* Search and Filter Controls */}
      <div className="mb-4 space-y-3">
        {/* Search Bar */}
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 text-black w-5 h-5" />
          <input
            type="text"
            aria-label="Search games"
            placeholder="Search games..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-10 py-2 border-4 border-black bg-white text-black placeholder-gray-500 focus:outline-none focus:bg-neobrutal-yellow font-bold"
          />
          {searchQuery && (
            <button
              aria-label="Clear game search"
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-black hover:text-black"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Friend Search */}
        {!publicView && <div className="space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 text-black w-5 h-5" />
              <input
                type="text"
                aria-label="Steam friend ID or profile URL"
                placeholder="Search friend by Steam ID or URL..."
                value={friendSearchQuery}
                onChange={(e) => setFriendSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleFriendSearch()}
                disabled={searchingFriend}
                className="w-full pl-10 pr-10 py-2 border-4 border-black bg-white text-black placeholder-gray-500 focus:outline-none focus:bg-neobrutal-yellow font-bold disabled:bg-gray-200"
              />
              {friendSearchQuery && !selectedFriend && (
                <button
                  aria-label="Clear friend search"
                  onClick={() => setFriendSearchQuery('')}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-black hover:text-black"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>
            {!selectedFriend && (
              <button
                onClick={handleFriendSearch}
                disabled={searchingFriend || !friendSearchQuery.trim()}
                className="px-4 py-2 border-4 border-black bg-neobrutal-yellow hover:bg-neobrutal-pink disabled:bg-gray-300 disabled:cursor-not-allowed text-black font-bold transition-colors"
              >
                {searchingFriend ? 'Searching...' : 'Search'}
              </button>
            )}
          </div>
          
          {friendError && <p role="alert" className="text-black font-bold bg-neobrutal-pink p-2 border-2 border-black">{friendError}</p>}
          {selectedFriend && (
            <div className="flex items-center gap-2 p-2 bg-neobrutal-green border-4 border-black">
              <Image
                src={selectedFriend.avatarMedium}
                alt={selectedFriend.personaName}
                width={32}
                height={32}
                className="border-2 border-black"
              />
              <span className="flex-1 text-black font-bold text-sm">
                Showing games in common with {selectedFriend.personaName}
              </span>
              <button
                aria-label="Clear friend filter"
                onClick={clearFriend}
                className="text-black hover:text-black transition-colors"
                title="Clear friend filter"
              >
                <UserX className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>}

        {/* Filter and Sort Controls */}
        <div className="flex flex-wrap gap-3">
          <select
            aria-label="Filter by playtime"
            value={filterBy}
            onChange={(e) => setFilterBy(e.target.value as typeof filterBy)}
            className="neobrutal-select px-3 py-2 border-4 border-black bg-white text-black focus:outline-none focus:bg-neobrutal-yellow font-bold"
          >
            <option value="all">All Games</option>
            <option value="played">Played</option>
            <option value="unplayed">Unplayed</option>
          </select>

          {!publicView && <select
            aria-label="Filter by genre"
            value={selectedGenre}
            onChange={(e) => setSelectedGenre(e.target.value)}
            disabled={genres.length === 0}
            className="neobrutal-select px-3 py-2 border-4 border-black bg-white text-black focus:outline-none focus:bg-neobrutal-yellow font-bold disabled:bg-gray-200 disabled:cursor-not-allowed"
          >
            <option value="all">All Genres</option>
            {genres.map((genre) => (
              <option key={genre} value={genre}>{genre}</option>
            ))}
          </select>}

          <select
            aria-label="Sort games"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="neobrutal-select px-3 py-2 border-4 border-black bg-white text-black focus:outline-none focus:bg-neobrutal-yellow font-bold"
          >
            <option value="name">Sort by Name</option>
            <option value="playtime">Sort by Playtime</option>
          </select>

          <div className="ml-auto text-sm text-black flex items-center font-bold">
            Showing {filteredAndSortedGames.length} of {games.length} games
          </div>
        </div>
      </div>

      {/* Games Grid */}
      {filteredAndSortedGames.length > 0 ? (
        <VirtualGameGrid
          key={JSON.stringify([searchQuery, sortBy, filterBy, selectedGenre, selectedFriend?.steamId])}
          games={filteredAndSortedGames}
        />
      ) : (
        <div className="text-center py-8">
          <p className="text-black font-bold">
            {searchQuery || filterBy !== 'all' || selectedGenre !== 'all' || selectedFriend
              ? 'No games match your filters.' 
              : 'No games found in your library.'}
          </p>
        </div>
      )}
    </div>
  );
});

GameList.displayName = 'GameList';

export default GameList;
