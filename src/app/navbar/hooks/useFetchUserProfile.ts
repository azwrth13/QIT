'use client';
import { useEffect, useState, useCallback } from 'react';

export interface UserProfile {
  steamId: string;
  personaName: string;
  profileUrl: string;
  avatarFull: string;
}

export const useFetchUserProfile = () => {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/user/profile');
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch user profile.');
      }
      const data = await response.json();
      setProfile(data);
    } catch (err) {
      setError((err as Error).message);
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
