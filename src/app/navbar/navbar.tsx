'use client';
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ComputerIcon as SteamIcon } from "lucide-react";

export default function Navbar() {
  const router = useRouter();

  const handleSteamLogin = () => {
    router.push("/api/auth/steam-login");
  };

  return (
    <header className="bg-[#1b2838] border-b border-[#2a475e]">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        {/* Logo and Branding */}
        <div className="flex items-center space-x-2">
          <div className="w-8 h-8">
            <img
              src="/placeholder.svg?height=32&width=32"
              alt="GMLNK Logo"
              className="w-full h-full object-contain"
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
          {/* Steam Login Button */}
          <button
            onClick={handleSteamLogin}
            className="flex items-center space-x-2 hover:text-blue-400 transition-colors"
          >
            <SteamIcon className="w-6 h-6" />
          </button>
        </nav>
      </div>
    </header>
  );
}
