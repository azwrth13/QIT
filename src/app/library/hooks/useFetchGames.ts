'use client';
import { useEffect, useState, useCallback, useRef } from "react";

import type { Game } from "../../../lib/games";

export const useFetchGames = () => {
  const [games, setGames] = useState<Game[]>([]);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const autoSynced = useRef(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch('/api/games/sync', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to refresh library');
      setGames(data.games || []);
      setLastSynced(data.lastSynced);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const fetchGames = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/games');
      if (response.status === 401) { setUnauthorized(true); setGames([]); return; }
      setUnauthorized(false);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to fetch games");
      }
      const data = await response.json();
      setGames(data.games || []);
      setLastSynced(data.lastSynced || null);
      if (data.autoSync && !autoSynced.current) {
        autoSynced.current = true;
        void refresh();
      }
    } catch (err) {
      setError((err as Error).message);
      setGames([]);
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  useEffect(() => {
    fetchGames();
  }, [fetchGames]);

  return { games, loading, error, unauthorized, lastSynced, refreshing, refresh, refetch: fetchGames };
};
