"use client";
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();

  const handleSteamLogin = () => {
    router.push('/api/auth/steam-login');
  };

  return (
    <div>
      <h1>Welcome to Steam Login App</h1>
      <button onClick={handleSteamLogin}>Login with Steam</button>
    </div>
  );
}
