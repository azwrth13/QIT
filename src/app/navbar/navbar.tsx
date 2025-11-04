// components/Navbar.tsx

'use client';

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ComputerIcon as SteamIcon } from "lucide-react";
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, Avatar } from "@nextui-org/react";
import { useFetchUserProfile } from "./hooks/useFetchUserProfile"; 
import { useState } from "react";

export default function Navbar() {
  const router = useRouter();
  const { profile, loading, error } = useFetchUserProfile();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleSteamLogin = () => {
    router.push("/api/auth/steam-login");
  };

  const handleSteamLogout = async () => {
    setIsLoggingOut(true);
    try {
      // Use window.location.href to perform a full page reload after logout
      window.location.href = "/api/auth/steam-logout";
      
      // await router.replace("/api/auth/steam-logout");
      // await refetch();
    } catch (error) {
      console.error("Logout failed:", error);
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <header className="bg-neobrutal-yellow border-b-4 border-black sticky top-0 z-50">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        {/* Logo and Branding */}
        <div className="flex items-center space-x-2">
          <Link href="/" className="text-xl font-pixel font-bold text-black">
            QIT
          </Link>
        </div>

        {/* Navigation Links */}
        <nav className="flex items-center space-x-6">
          <Link href="/" className="font-bold text-black hover:text-neobrutal-pink transition-colors">
            Home
          </Link>
          <Link href="/library" className="font-bold text-black hover:text-neobrutal-pink transition-colors">
            Library
          </Link>

          {/* Authentication Controls */}
          {loading ? (
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-neobrutal-blue border-4 border-black animate-pulse" />
              <span className="text-black text-sm font-bold">Loading...</span>
            </div>
          ) : profile ? (
            // User is authenticated: Show Profile Dropdown
            <Dropdown placement="bottom-end">
              <DropdownTrigger>
                <Avatar
                  isBordered
                  as="button"
                  size="sm"
                  src={profile.avatarFull}
                  alt={`${profile.personaName}'s avatar`}
                  className="transition-transform"
                />
              </DropdownTrigger>
              <DropdownMenu 
                aria-label="Profile Actions" 
                className="bg-white border-4 border-black shadow-neobrutal"
                itemClasses={{
                  base: "data-[hover=true]:bg-neobrutal-yellow",
                }}
              >
                <DropdownItem 
                  key="profile" 
                  className="h-14 gap-2 bg-white data-[hover=true]:bg-neobrutal-yellow"
                  textValue="Profile"
                >
                  <div className="flex flex-col">
                    <p className="font-bold text-black">Signed in as</p>
                    <p className="font-bold text-black">{profile.personaName}</p>
                  </div>
                </DropdownItem>
                <DropdownItem
                  key="logout"
                  as="button" 
                  onClick={handleSteamLogout} 
                  className="w-full text-left flex items-center justify-between bg-white data-[hover=true]:bg-neobrutal-pink font-bold text-black"
                  textValue="Logout"
                >
                  {isLoggingOut ? "Logging out..." : "Log Out"}
                </DropdownItem>
              </DropdownMenu>
            </Dropdown>
          ) : (
            // User is not authenticated: Show Steam Login Button
            <>
              {/* Optionally display error message related to authentication */}
              {error && error !== "Not authenticated. Steam ID is missing." && (
                <div className="text-neobrutal-pink mr-4 font-bold">
                  {`Error: ${error}`}
                </div>
              )}
              <button
                onClick={handleSteamLogin}
                className="flex items-center space-x-2 bg-neobrutal-blue border-4 border-black shadow-neobrutal px-4 py-2 font-bold text-black hover:bg-neobrutal-green transition-colors"
              >
                <SteamIcon className="w-6 h-6" />
                <span>Sign In with Steam</span>
              </button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
