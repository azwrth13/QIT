'use client';

import { X } from 'lucide-react';
import BrowserWindow from '../../components/BrowserWindow';

interface HelpPopoutProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function HelpPopout({ isOpen, onClose }: HelpPopoutProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <BrowserWindow title="HOW TO USE QIT">
          <div className="space-y-6">
            {/* Filter List Section */}
            <div className="bg-neobrutal-blue border-4 border-black shadow-neobrutal p-5">
              <h2 className="text-2xl font-bold text-black mb-4">Filter List</h2>
              <div className="space-y-3 text-black font-bold">
                <div>
                  <h3 className="text-lg mb-2">• Search Games</h3>
                  <p className="text-sm ml-4">Type in the search bar to find games by name. The list updates as you type.</p>
                </div>
                <div>
                  <h3 className="text-lg mb-2">• Filter by Playtime</h3>
                  <p className="text-sm ml-4">Choose &quot;All Games&quot;, &quot;Played&quot; (games with playtime), or &quot;Unplayed&quot; (0 minutes) to narrow down your library.</p>
                </div>
                <div>
                  <h3 className="text-lg mb-2">• Filter by Genre</h3>
                  <p className="text-sm ml-4">Select a genre from the dropdown to show only games of that type. Genres load automatically.</p>
                </div>
                <div>
                  <h3 className="text-lg mb-2">• Sort Options</h3>
                  <p className="text-sm ml-4">Sort by &quot;Name&quot; (alphabetical) or &quot;Playtime&quot; (most played first) to organize your games.</p>
                </div>
              </div>
            </div>

            {/* Search with Friend Section */}
            <div className="bg-neobrutal-green border-4 border-black shadow-neobrutal p-5">
              <h2 className="text-2xl font-bold text-black mb-4">Search with Friend</h2>
              <div className="space-y-3 text-black font-bold">
                <div>
                  <p className="text-sm mb-2">Find games you both own by searching for a friend:</p>
                  <ol className="list-decimal list-inside space-y-2 text-sm ml-2">
                    <li>Enter your friend&apos;s Steam ID or profile URL in the friend search box</li>
                    <li>Click &quot;Search&quot; or press Enter</li>
                    <li>Once found, the game list will automatically filter to show only games you both own</li>
                    <li>Click the X icon next to your friend&apos;s name to clear the filter</li>
                  </ol>
                </div>
                <div className="mt-3 p-3 bg-neobrutal-yellow border-2 border-black">
                  <p className="text-sm font-bold">Tip: The randomizer will only pick from games you have in common when a friend is selected!</p>
                </div>
              </div>
            </div>

            {/* Randomize Section */}
            <div className="bg-neobrutal-yellow border-4 border-black shadow-neobrutal p-5">
              <h2 className="text-2xl font-bold text-black mb-4">Randomize</h2>
              <div className="space-y-3 text-black font-bold">
                <div>
                  <p className="text-sm mb-2">Click &quot;Pick a Random Game&quot; to let QIT choose for you:</p>
                  <ul className="list-disc list-inside space-y-2 text-sm ml-2">
                    <li>The randomizer selects from your <strong>currently filtered</strong> game list</li>
                    <li>If you&apos;ve applied filters (search, genre, playtime, or friend), it only picks from those games</li>
                    <li>If no filters are active, it picks from your entire library</li>
                    <li>The selected game appears with its icon, name, playtime, and a link to Steam</li>
                  </ul>
                </div>
                <div className="mt-3 p-3 bg-neobrutal-pink border-2 border-black">
                  <p className="text-sm font-bold">Remember: Filters affect what games can be randomized! Clear filters to randomize from your full library.</p>
                </div>
              </div>
            </div>

            {/* Close Button */}
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="bg-neobrutal-pink hover:bg-neobrutal-purple border-4 border-black shadow-neobrutal text-black font-bold py-2 px-6 transition-colors flex items-center gap-2"
              >
                <X className="w-5 h-5" />
                Got it!
              </button>
            </div>
          </div>
        </BrowserWindow>
      </div>
    </div>
  );
}

