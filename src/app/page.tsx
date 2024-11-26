import { SearchIcon } from 'lucide-react'

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-4rem)] bg-[#1b2838]">
      <div className="w-full max-w-xl px-4">
        <div className="relative">
          <input
            type="text"
            placeholder="Steam ID or Profile URL"
            className="w-full py-3 px-4 pr-10 rounded-full bg-[#2a475e] text-white placeholder-[#8f98a0] focus:outline-none focus:ring-2 focus:ring-[#66c0f4]"
          />
          <SearchIcon className="absolute right-4 top-1/2 transform -translate-y-1/2 text-[#8f98a0]" />
        </div>
        <p className="mt-2 text-center text-sm text-[#8f98a0]">
          Search public Steam profile's
        </p>
      </div>
    </div>
  )
}