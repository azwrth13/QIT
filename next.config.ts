import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: {
    appIsrStatus: false,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'media.steampowered.com',
        pathname: '/steamcommunity/public/images/apps/**',
      },
      {
        protocol: 'https',
        hostname: 'avatars.steamstatic.com',
      },
      {
        protocol: 'https',
        hostname: 'steamcdn-a.akamaihd.net',
      },
    ],
  },
};

export default nextConfig;
