// components/GamesList.tsx

'use client';

import { useState, useMemo, memo, useCallback, useEffect } from 'react';
import Image from 'next/image';
import { SearchIcon, X, UserX } from 'lucide-react';
import { Game } from "../hooks/useFetchGames";
import { fetchGenreBatches } from '@/lib/genres';

interface GameListProps {
  games: Game[];
  onFilteredGamesChange?: (filteredGames: Game[]) => void;
}

interface FriendProfile {
  steamId: string;
  personaName: string;
  avatarMedium: string;
}

const GameList = memo(function GameList({ games, onFilteredGamesChange }: GameListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'playtime'>('name');
  const [filterBy, setFilterBy] = useState<'all' | 'played' | 'unplayed'>('all');
  const [selectedGenre, setSelectedGenre] = useState<string>('all');
  const [gamesWithGenres, setGamesWithGenres] = useState<Game[]>(games);
  const [genres, setGenres] = useState<string[]>([]);
  const [loadingGenres, setLoadingGenres] = useState(false);
  
  // Friend search state
  const [friendSearchQuery, setFriendSearchQuery] = useState('');
  const [searchingFriend, setSearchingFriend] = useState(false);
  const [selectedFriend, setSelectedFriend] = useState<FriendProfile | null>(null);
  const [friendGames, setFriendGames] = useState<Game[]>([]);
  const [loadingFriendGames, setLoadingFriendGames] = useState(false);

  // Fetch genres for games
  useEffect(() => {
    let isCancelled = false;

    const fetchGenres = async () => {
      if (games.length === 0) return;
      
      setLoadingGenres(true);
      const gamesNeedingGenres = games.filter(g => !g.genres || g.genres.length === 0);
      
      if (gamesNeedingGenres.length === 0) {
        // Extract genres from existing games
        const allGenres = new Set<string>();
        games.forEach(game => {
          if (game.genres) {
            game.genres.forEach(genre => allGenres.add(genre));
          }
        });
        if (!isCancelled) {
          setGenres(Array.from(allGenres).sort());
          setGamesWithGenres(games);
          setLoadingGenres(false);
        }
        return;
      }

      try {
        const data = await fetchGenreBatches(gamesNeedingGenres.map(g => g.appid));
        const genresMap = data.genres;

        if (isCancelled) return;

        // Update games with genres
        const updatedGames = games.map(game => {
          if (genresMap[game.appid]) {
            return { ...game, genres: genresMap[game.appid] };
          }
          return game;
        });

        // Extract all unique genres
        const allGenres = new Set<string>();
        updatedGames.forEach(game => {
          if (game.genres) {
            game.genres.forEach(genre => allGenres.add(genre));
          }
        });

        if (!isCancelled) {
          setGamesWithGenres(updatedGames);
          setGenres(Array.from(allGenres).sort());
          
          // Log summary if there were errors
          if (data.errorCount > 0) {
            console.warn(
              `Fetched genres for ${data.successCount} games. ${data.errorCount} games failed.`
            );
          }
        }
      } catch (error) {
        if (!isCancelled) {
          // Log summary error instead of individual errors
          console.error('Failed to fetch genres:', error);
        }
      } finally {
        if (!isCancelled) {
          setLoadingGenres(false);
        }
      }
    };

    fetchGenres();

    // Cleanup function to cancel requests if component unmounts
    return () => {
      isCancelled = true;
    };
  }, [games]);

  // Search for friend
  const handleFriendSearch = useCallback(async () => {
    if (!friendSearchQuery.trim()) return;

    setSearchingFriend(true);
    try {
      const response = await fetch(`/api/steam/search?q=${encodeURIComponent(friendSearchQuery)}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to search friend');
      }

      setSelectedFriend({
        steamId: data.steamId,
        personaName: data.personaName,
        avatarMedium: data.avatarMedium,
      });

      // Fetch friend's games
      setLoadingFriendGames(true);
      const gamesResponse = await fetch(`/api/games/friend?steamid=${data.steamId}`);
      const gamesData = await gamesResponse.json();

      if (!gamesResponse.ok) {
        throw new Error(gamesData.error || 'Failed to fetch friend games');
      }

      setFriendGames(gamesData.games || []);
    } catch (error) {
      console.error('Error searching friend:', error);
      alert((error as Error).message || 'Failed to search for friend');
    } finally {
      setSearchingFriend(false);
      setLoadingFriendGames(false);
    }
  }, [friendSearchQuery]);

  const clearFriend = useCallback(() => {
    setSelectedFriend(null);
    setFriendGames([]);
    setFriendSearchQuery('');
  }, []);

  // Helper function to convert minutes to hours and minutes (memoized)
  const formatPlaytime = useCallback((minutes: number | undefined): string => {
    if (!minutes || minutes <= 0) return "0h 0m";
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }, []);

  // Filter and sort games
  const filteredAndSortedGames = useMemo(() => {
    let filtered = gamesWithGenres;

    // Filter by friend's games (common games only)
    if (selectedFriend && friendGames.length > 0) {
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
            placeholder="Search games..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-10 py-2 border-4 border-black bg-white text-black placeholder-gray-500 focus:outline-none focus:bg-neobrutal-yellow font-bold"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-black hover:text-neobrutal-pink"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Friend Search */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-3 top-1/2 transform -translate-y-1/2 text-black w-5 h-5" />
              <input
                type="text"
                placeholder="Search friend by Steam ID or URL..."
                value={friendSearchQuery}
                onChange={(e) => setFriendSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleFriendSearch()}
                disabled={searchingFriend}
                className="w-full pl-10 pr-10 py-2 border-4 border-black bg-white text-black placeholder-gray-500 focus:outline-none focus:bg-neobrutal-yellow font-bold disabled:bg-gray-200"
              />
              {friendSearchQuery && !selectedFriend && (
                <button
                  onClick={() => setFriendSearchQuery('')}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-black hover:text-neobrutal-pink"
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
                {loadingFriendGames && ' (loading...)'}
              </span>
              <button
                onClick={clearFriend}
                className="text-black hover:text-neobrutal-pink transition-colors"
                title="Clear friend filter"
              >
                <UserX className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>

        {/* Filter and Sort Controls */}
        <div className="flex flex-wrap gap-3">
          <select
            value={filterBy}
            onChange={(e) => setFilterBy(e.target.value as typeof filterBy)}
            className="neobrutal-select px-3 py-2 border-4 border-black bg-white text-black focus:outline-none focus:bg-neobrutal-yellow font-bold"
          >
            <option value="all">All Games</option>
            <option value="played">Played</option>
            <option value="unplayed">Unplayed</option>
          </select>

          <select
            value={selectedGenre}
            onChange={(e) => setSelectedGenre(e.target.value)}
            disabled={loadingGenres || genres.length === 0}
            className="neobrutal-select px-3 py-2 border-4 border-black bg-white text-black focus:outline-none focus:bg-neobrutal-yellow font-bold disabled:bg-gray-200 disabled:cursor-not-allowed"
          >
            <option value="all">All Genres</option>
            {genres.map((genre) => (
              <option key={genre} value={genre}>{genre}</option>
            ))}
          </select>

          <select
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
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 max-h-[600px] overflow-y-auto">
          {filteredAndSortedGames.map((game) => (
            <div key={game.appid} className="text-center p-3 bg-neobrutal-blue border-4 border-black shadow-neobrutal-sm hover:bg-neobrutal-green transition-colors">
              {game.img_icon_url ? (
                <div className="w-12 h-12 mx-auto mb-2 relative border-2 border-black">
                  <Image
                    src={`https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg`}
                    alt={`${game.name} icon`}
                    fill
                    className="object-contain pixelated"
                    sizes="48px"
                    unoptimized
                  />
                </div>
              ) : (
                <div className="w-12 h-12 mx-auto mb-2 bg-neobrutal-pink border-2 border-black flex items-center justify-center">
                  <span className="text-black text-xs font-bold">No Image</span>
                </div>
              )}
              <p className="font-bold text-sm mb-1 line-clamp-2 text-black">{game.name}</p>
              <p className="text-xs text-black font-bold">
                {formatPlaytime(game.playtime_forever)}
              </p>
            </div>
          ))}
        </div>
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
