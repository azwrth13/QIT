'use client';

import { useState, memo, useCallback } from 'react';
import Image from 'next/image';
import { Game, formatPlaytime, pickGame } from "../../../lib/games";
import { Dice6, X } from 'lucide-react';
import BrowserWindow from '../../components/BrowserWindow';

interface RandomGamePickerProps {
  games: Game[];
  showLaunchButton?: boolean;
}

const RandomGamePicker = memo(function RandomGamePicker({ games, showLaunchButton = false }: RandomGamePickerProps) {
  const [selectedGame, setSelectedGame] = useState<Game | null>(null);

  const pickRandomGame = useCallback(() => {
    setSelectedGame(pickGame(games));
  }, [games]);

  return (
    <BrowserWindow title="RANDOM GAME PICKER">
      <button
        onClick={pickRandomGame}
        disabled={games.length === 0}
        className="w-full bg-neobrutal-yellow hover:bg-neobrutal-pink disabled:bg-gray-300 disabled:cursor-not-allowed border-4 border-black shadow-neobrutal text-black font-bold py-3 px-4 transition-colors flex items-center justify-center gap-2"
      >
        <Dice6 className="w-5 h-5" />
        Pick a Random Game
      </button>

      {games.length === 0 && (
        <p className="mt-4 text-sm text-black text-center font-bold">
          No games available to pick from!
        </p>
      )}

      {/* Selected Game Display */}
      {selectedGame && games.some(game => game.appid === selectedGame.appid) && (
        <div className="mt-6 p-4 bg-neobrutal-green border-4 border-black shadow-neobrutal animate-in fade-in slide-in-from-bottom-4">
          <div className="flex items-start justify-between mb-3">
            <h4 className="text-lg font-bold text-black">Your Random Game:</h4>
            <button
              onClick={() => setSelectedGame(null)}
              className="text-black hover:text-black transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          
          <div className="flex items-center gap-4">
            {selectedGame.img_icon_url ? (
              <div className="w-16 h-16 relative flex-shrink-0 border-4 border-black">
                <Image
                  src={`https://media.steampowered.com/steamcommunity/public/images/apps/${selectedGame.appid}/${selectedGame.img_icon_url}.jpg`}
                  alt={`${selectedGame.name} icon`}
                  fill
                  className="object-contain pixelated"
                  sizes="64px"
                  unoptimized
                />
              </div>
            ) : (
              <div className="w-16 h-16 bg-neobrutal-pink border-4 border-black flex items-center justify-center flex-shrink-0">
                <span className="text-black text-xs font-bold">No Image</span>
              </div>
            )}
            
            <div className="flex-1 min-w-0">
              <h5 className="text-xl font-bold mb-1 text-black">{selectedGame.name}</h5>
              <p className="text-sm text-black font-bold">
                Playtime: {formatPlaytime(selectedGame.playtime_forever)}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {showLaunchButton && (
                  <a
                    href={`steam://run/${selectedGame.appid}`}
                    className="inline-block bg-neobrutal-yellow hover:bg-neobrutal-pink border-4 border-black shadow-neobrutal px-4 py-2 text-black font-bold transition-colors"
                  >
                    Play / Launch in Steam
                  </a>
                )}
                <a
                  href={`https://store.steampowered.com/app/${selectedGame.appid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-black hover:text-black transition-colors font-bold underline"
                >
                  View on Steam →
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </BrowserWindow>
  );
});

RandomGamePicker.displayName = 'RandomGamePicker';

export default RandomGamePicker;
