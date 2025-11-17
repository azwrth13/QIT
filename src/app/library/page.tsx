'use client';
import { useState, useEffect } from 'react';
import { Info } from 'lucide-react';
import { useFetchGames, Game } from "./hooks/useFetchGames";
import GameList from "./components/GamesList";
import RandomGamePicker from "./components/RandomGamePicker";
import LoadingSkeleton from "./components/LoadingSkeleton";
import BrowserWindow from "../components/BrowserWindow";
import HelpPopout from "./components/HelpPopout";

export default function Library() {
  const { games, loading, error } = useFetchGames();
  const [filteredGames, setFilteredGames] = useState<Game[]>([]);
  const [showHelp, setShowHelp] = useState(false);

  // Initialize filteredGames when games are loaded
  useEffect(() => {
    if (games.length > 0 && filteredGames.length === 0) {
      setFilteredGames(games);
    }
  }, [games, filteredGames.length]);

  // Show help popout automatically on first visit (when games are loaded)
  useEffect(() => {
    if (!loading && !error && games.length > 0) {
      const helpShown = localStorage.getItem('qit-help-shown');
      if (!helpShown) {
        setShowHelp(true);
      }
    }
  }, [loading, error, games.length]);

  const handleCloseHelp = () => {
    setShowHelp(false);
    localStorage.setItem('qit-help-shown', 'true');
  };

  const handleOpenHelp = () => {
    setShowHelp(true);
  };

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Help Popout */}
      <HelpPopout isOpen={showHelp} onClose={handleCloseHelp} />

      {/* Info Button */}
      <button
        onClick={handleOpenHelp}
        className="fixed top-20 right-4 z-40 w-12 h-12 bg-neobrutal-blue hover:bg-neobrutal-green border-4 border-black shadow-neobrutal flex items-center justify-center transition-colors"
        title="Show Help"
        aria-label="Show Help"
      >
        <Info className="w-6 h-6 text-black" />
      </button>

      {/* Header Section */}
      <BrowserWindow title="WELCOME TO QIT" className="mb-8">
        <h1 className="text-3xl font-pixel font-bold mb-2 text-black">Welcome to QIT</h1>
        <h2 className="text-2xl font-bold mb-4 text-black">Steam Library Randomizer</h2>
        <p className="text-black font-bold">Can&apos;t decide what to play? Explore, filter, and let us pick a random game for you!</p>
      </BrowserWindow>

      {/* Error State */}
      {error && (
        <BrowserWindow title="ERROR" className="mb-8">
          <div className="bg-neobrutal-pink border-4 border-black shadow-neobrutal p-4">
            <p className="text-black font-bold">Error Loading Games</p>
            <p className="text-black text-sm mt-1 font-bold">{error}</p>
            <p className="text-black text-sm mt-2 font-bold">Please try refreshing the page or signing in again.</p>
          </div>
        </BrowserWindow>
      )}

      {/* Loading State */}
      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div>
            <h3 className="text-xl font-bold mb-4 text-black">Your Games</h3>
            <LoadingSkeleton />
          </div>
          <div>
            <h3 className="text-xl font-bold mb-4 text-black">Random Game Picker</h3>
            <BrowserWindow title="RANDOM GAME PICKER">
              <div className="h-10 bg-neobrutal-blue border-4 border-black animate-pulse mb-4" />
              <div className="h-12 bg-neobrutal-green border-4 border-black animate-pulse" />
            </BrowserWindow>
          </div>
        </div>
      )}

      {/* Game Filters and Game List */}
      {!loading && !error && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <h3 className="text-xl font-bold mb-4 text-black">Your Games</h3>
            <GameList games={games} onFilteredGamesChange={setFilteredGames} />
          </div>
          <div>
            <h3 className="text-xl font-bold mb-4 text-black">Random Game Picker</h3>
            <RandomGamePicker games={filteredGames.length > 0 ? filteredGames : (games || [])} />
          </div>
        </div>
      )}
    </div>
  );
}
