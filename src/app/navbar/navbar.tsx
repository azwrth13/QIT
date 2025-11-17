// components/Navbar.tsx

'use client';

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ComputerIcon as SteamIcon } from "lucide-react";
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, Avatar } from "@nextui-org/react";
import { useFetchUserProfile } from "./hooks/useFetchUserProfile"; 
import { useState } from "react";
import LogoutConfirmModal from "./components/LogoutConfirmModal";

export default function Navbar() {
  const router = useRouter();
  const { profile, loading, error } = useFetchUserProfile();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const handleSteamLogin = () => {
    router.push("/api/auth/steam-login");
  };

  const handleLogoutClick = () => {
    setShowLogoutConfirm(true);
  };

  const handleSteamLogout = async () => {
    setShowLogoutConfirm(false);
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
    <>
      <LogoutConfirmModal
        isOpen={showLogoutConfirm}
        onConfirm={handleSteamLogout}
        onCancel={() => setShowLogoutConfirm(false)}
        userName={profile?.personaName}
      />
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
                className="bg-white border-4 border-black shadow-neobrutal p-2"
                itemClasses={{
                  base: "data-[hover=true]:bg-neobrutal-yellow rounded-none",
                }}
              >
                <DropdownItem 
                  key="profile" 
                  className="h-auto min-h-[80px] gap-3 bg-white data-[hover=true]:bg-neobrutal-yellow py-4 px-4"
                  textValue="Profile"
                  isReadOnly
                >
                  <div className="flex flex-col gap-2">
                    <p className="font-bold text-black text-sm">Signed in as</p>
                    <p className="font-bold text-black text-base">{profile.personaName}</p>
                  </div>
                </DropdownItem>
                <DropdownItem
                  key="logout"
                  as="button" 
                  onClick={handleLogoutClick} 
                  className="w-full text-left flex items-center justify-between bg-white data-[hover=true]:bg-neobrutal-pink font-bold text-black py-4 px-4 mt-2"
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
    </>
  );
}
