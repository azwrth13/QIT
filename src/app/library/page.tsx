import { GamepadIcon } from 'lucide-react'

export default function Library() {
  return (
    <div className="container mx-auto px-4 py-8">
      <div className="bg-[#1f3141] border border-[#2a475e] rounded-lg p-6 mb-8">
        <h1 className="text-3xl font-bold mb-2">Welcome to GMLNK, a</h1>
        <h2 className="text-3xl font-bold mb-4">Steam library randomizer</h2>
        <p className="text-gray-400">Can't decide what to play? Explore, filter, and play solo or with friends!</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <div>
          <h3 className="text-xl font-semibold mb-4">Filter Games</h3>
          <div className="bg-[#2a475e] rounded-lg p-4">
            <p className="text-gray-400 mb-4">Select game tags to filter the list</p>
            <div className="flex flex-wrap gap-2">
              {['Horror', 'FPS', 'RPG'].map((tag) => (
                <button
                  key={tag}
                  className="px-3 py-1 rounded-full bg-[#1f3141] text-white hover:bg-blue-600 transition-colors"
                >
                  {tag}
                </button>
              ))}
            </div>
            <button className="mt-4 w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition-colors">
              Apply Filters
            </button>
          </div>
        </div>

        <div>
          <h3 className="text-xl font-semibold mb-4">Your Games</h3>
          <div className="bg-[#2a475e] rounded-lg p-4">
            <div className="grid grid-cols-3 gap-4">
              {['Game Title 1', 'Game Title 2', 'Game Title 3'].map((game, index) => (
                <div key={game} className="text-center">
                  <GamepadIcon className="w-12 h-12 mx-auto mb-2" />
                  <p className="font-semibold">{game}</p>
                  <p className="text-sm text-gray-400">Category: {['RPG', 'Adventure', 'FPS'][index]}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-8">
        <div>
          <h3 className="text-xl font-semibold mb-4">Random Game Picker</h3>
          <div className="bg-[#2a475e] rounded-lg p-4">
            <p className="text-gray-400 mb-4">Click below to pick a random game from your library</p>
            <button className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition-colors">
              Pick a Random Game
            </button>
          </div>
        </div>

        <div>
          <h3 className="text-xl font-semibold mb-4">Random Game</h3>
          <div className="bg-[#2a475e] rounded-lg p-4 h-[104px] flex items-center justify-center">
            <p className="text-gray-400">Your random game will appear here</p>
          </div>
        </div>
      </div>

      <div className="mt-8">
        <h3 className="text-xl font-semibold mb-4">Add your friends!</h3>
        <div className="bg-[#2a475e] rounded-lg p-4">
          <input
            type="text"
            placeholder="Enter your friend's Steam ID"
            className="w-full mb-4 py-2 px-4 rounded bg-[#1f3141] text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition-colors">
            Find Friends
          </button>
        </div>
      </div>

      <div className="mt-8">
        <h3 className="text-xl font-semibold mb-4">Common Games</h3>
        <p className="text-gray-400 mb-4">Games in common with friends</p>
        <div className="bg-[#2a475e] rounded-lg p-4">
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-4">
            {['Game A', 'Game B', 'Game C', 'Game D', 'Game E'].map((game, index) => (
              <div key={game} className="text-center">
                <GamepadIcon className="w-12 h-12 mx-auto mb-2" />
                <p className="font-semibold">{game}</p>
                <p className="text-sm text-gray-400">{['FPS', 'RPG', 'Horror', 'FPS', 'RPG'][index]}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}