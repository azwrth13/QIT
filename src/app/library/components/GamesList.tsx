// components/GamesList.tsx

import { Game } from "../hooks/useFetchGames";

interface GameListProps {
  games: Game[];
}

export default function GameList({ games }: GameListProps) {
  // Helper function to convert minutes to hours and minutes
  const formatPlaytime = (minutes: number | undefined): string => {
    if (!minutes || minutes <= 0) return "0h 0m";
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  };

  return (
    <div className="bg-[#2a475e] rounded-lg p-4">
      {games.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {games.map((game) => (
            <div key={game.appid} className="text-center">
              {game.img_icon_url ? (
                <img
                  src={`https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg`}
                  alt={`${game.name} icon`}
                  className="w-12 h-12 mx-auto mb-2"
                  loading="lazy" // Optional: Lazy load images
                />
              ) : (
                // Fallback if img_icon_url is missing
                <div className="w-12 h-12 mx-auto mb-2 bg-gray-400 rounded-full flex items-center justify-center">
                  <span className="text-white text-xs">No Image</span>
                </div>
              )}
              <p className="font-semibold">{game.name}</p>
              <p className="text-sm text-gray-400">
                Playtime: {formatPlaytime(game.playtime_forever)}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-gray-400">No games found in your library.</p>
      )}
    </div>
  );
}
