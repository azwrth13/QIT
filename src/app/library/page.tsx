"use client";
import { useEffect, useState } from 'react';

interface Game {
  appid: number;
  name: string;
}

export default function Library() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchGames = async () => {
      try {
        const response = await fetch(`/api/games?steamId=YOUR_USER_STEAM_ID`);
        if (!response.ok) {
          throw new Error('Failed to fetch games');
        }
        const data = await response.json();
        console.log('Fetched games:', data.games); // Log the fetched games data
        setGames(data.games || []);
      } catch (err) {
        console.error('Error fetching games:', err);
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    };

    fetchGames();
  }, []);

  if (loading) return <p>Loading your game library...</p>;
  if (error) return <p>Error: {error}</p>;

  return (
    <div>
      <h1>Your Game Library</h1>
      {games.length > 0 ? (
        <ul>
          {games.map((game) => (
            <li key={game.appid}>
              <strong>{game.name}</strong> (AppID: {game.appid})
            </li>
          ))}
        </ul>
      ) : (
        <p>No games found in your library.</p>
      )}
    </div>
  );
}
