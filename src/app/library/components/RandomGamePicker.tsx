import { Game } from "../hooks/useFetchGames";

interface RandomGamePickerProps {
  games: Game[];
}

export default function RandomGamePicker({ games }: RandomGamePickerProps) {
  const pickRandomGame = () => {
    if (games.length > 0) {
      const randomIndex = Math.floor(Math.random() * games.length);
      alert(`Your random game is: ${games[randomIndex].name}`);
    } else {
      alert("No games available to pick from!");
    }
  };

  return (
    <div className="bg-[#2a475e] rounded-lg p-4">
      <p className="text-gray-400 mb-4">Click below to pick a random game from your library</p>
      <button
        onClick={pickRandomGame}
        className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition-colors"
      >
        Pick a Random Game
      </button>
    </div>
  );
}
