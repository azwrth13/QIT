// components/Navbar.tsx

'use client';

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ComputerIcon as SteamIcon } from "lucide-react";
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem, Avatar } from "@nextui-org/react";
import { useFetchUserProfile } from "./hooks/useFetchUserProfile"; // Adjust the import path as needed
import Image from "next/image";
import { useState } from "react";

export default function Navbar() {
  const router = useRouter();
  const { profile, loading, error } = useFetchUserProfile();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleSteamLogin = () => {
    router.push("/api/auth/steam-login"); // Ensure this endpoint is correctly implemented
  };

  const handleSteamLogout = async () => {
    setIsLoggingOut(true);
    try {
      // Use window.location.href to perform a full page reload after logout
      window.location.href = "/api/auth/steam-logout";
      // Alternatively, if you prefer not to reload, you can use router.replace and then refetch
      // await router.replace("/api/auth/steam-logout");
      // await refetch();
    } catch (error) {
      console.error("Logout failed:", error);
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <header className="bg-[#1b2838] border-b border-[#2a475e]">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        {/* Logo and Branding */}
        <div className="flex items-center space-x-2">
          <div className="w-8 h-8 relative">
            <Image
              src="/placeholder.svg" // Ensure this path is correct and the image exists in the public folder
              alt="GMLNK Logo"
              fill // Updated from 'layout="fill"' to 'fill' as per Next.js Image component
              style={{ objectFit: "contain" }} // Updated from 'objectFit' prop
              priority // Optional: Loads the image with high priority
            />
          </div>
          <Link href="/" className="text-xl font-bold text-white">
            GMLNK
          </Link>
        </div>

        {/* Navigation Links */}
        <nav className="flex items-center space-x-6">
          <Link href="/" className="hover:text-blue-400 transition-colors">
            Home
          </Link>
          <Link href="/library" className="hover:text-blue-400 transition-colors">
            Library
          </Link>
          <Link href="/friends" className="hover:text-blue-400 transition-colors">
            Friends
          </Link>
          <Link href="/settings" className="hover:text-blue-400 transition-colors">
            Settings
          </Link>

          {/* Authentication Controls */}
          {loading ? (
            <div className="text-gray-400">Loading...</div>
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
              <DropdownMenu aria-label="Profile Actions" variant="flat">
                <DropdownItem key="profile" className="h-14 gap-2">
                  <div className="flex flex-col">
                    <p className="font-semibold">Signed in as</p>
                    <p className="font-semibold">{profile.personaName}</p>
                  </div>
                </DropdownItem>
                <DropdownItem key="settings">
                  <Link href="/settings">My Settings</Link>
                </DropdownItem>
                {/* Add more DropdownItems as needed */}
                <DropdownItem
                  key="logout"
                  color="danger"
                  as="button" // Changed from 'a' to 'button'
                  onClick={handleSteamLogout} // Use onClick to trigger logout
                  className="w-full text-left flex items-center justify-between"
                  //
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
                <div className="text-red-500 mr-4">
                  {`Error: ${error}`}
                </div>
              )}
              <button
                onClick={handleSteamLogin}
                className="flex items-center space-x-2 hover:text-blue-400 transition-colors"
              >
                <SteamIcon className="w-6 h-6" />
                <span className="text-white">Sign In with Steam</span>
              </button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
