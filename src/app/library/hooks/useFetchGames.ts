'use client';
import { useEffect, useState } from "react";

export interface Game {
  appid: number;
  name: string;
  img_icon_url?: string;
  playtime_forever?: number;
}

export const useFetchGames = () => {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchGames = async () => {
      try {
        const response = await fetch('/api/games');
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to fetch games");
        }
        const data = await response.json();
        setGames(data.games || []);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    };

    fetchGames();
  }, []);

  return { games, loading, error };
};
