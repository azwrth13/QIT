'use client';
import { useEffect, useState, useCallback } from 'react';

export interface UserProfile {
  steamId: string;
  personaName: string;
  profileUrl: string;
  avatarFull: string;
  tz?: string;
}

export const useFetchUserProfile = () => {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/user/profile', { cache: 'no-store' });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch user profile.');
      }
      const data = await response.json();
      setProfile(data);
      if (!data.tz) {
        // Best-effort profile setting; a failed capture must not hide an otherwise valid profile.
        try {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const saved = await fetch('/api/user/profile', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tz, onlyIfMissing: true }),
          });
          if (saved.ok) setProfile({ ...data, tz: (await saved.json()).tz });
        } catch { /* Retry on the next profile load. */ }
      }
    } catch (err) {
      if ((err as Error).message !== 'Not authenticated. Steam ID is missing.') setError((err as Error).message);
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  return { profile, loading, error, refetch: fetchProfile };
};
