'use client';
import { useEffect, useState, useCallback } from "react";

export interface Game {
  appid: number;
  name: string;
  img_icon_url?: string;
  playtime_forever?: number;
  genres?: string[];
}

export const useFetchGames = () => {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchGames = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/games');
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to fetch games");
      }
      const data = await response.json();
      setGames(data.games || []);
    } catch (err) {
      setError((err as Error).message);
      setGames([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGames();
  }, [fetchGames]);

  return { games, loading, error, refetch: fetchGames };
};
