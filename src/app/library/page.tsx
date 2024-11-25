'use client';
import { useFetchGames } from "./hooks/useFetchGames";
import GameList from "./components/GamesList";
import RandomGamePicker from "./components/RandomGamePicker";

export default function Library() {
  const { games, loading, error } = useFetchGames();

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Header Section */}
      <div className="bg-[#1f3141] border border-[#2a475e] rounded-lg p-6 mb-8">
        <h1 className="text-3xl font-bold mb-2">Welcome to GMLNK</h1>
        <h2 className="text-3xl font-bold mb-4">Steam Library Randomizer</h2>
        <p className="text-gray-400">Can't decide what to play? Explore, filter, and play solo or with friends!</p>
      </div>

      {/* Error or Loading State */}
      {loading && <p>Loading your game library...</p>}
      {error && <p className="text-red-500">Error: {error}</p>}

      {/* Game Filters and Game List */}
      {!loading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div>
            <h3 className="text-xl font-semibold mb-4">Your Games</h3>
            <GameList games={games} />
          </div>
          <div>
            <h3 className="text-xl font-semibold mb-4">Random Game Picker</h3>
            <RandomGamePicker games={games} />
          </div>
        </div>
      )}
    </div>
  );
}
