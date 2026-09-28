'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import type { Game } from '../../../lib/games';
import { formatPlaytime } from '../../../lib/games';

const rowHeight = 164;

export default function VirtualGameGrid({ games }: { games: Game[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (container.current) container.current.scrollTop = 0; setScrollTop(0); }, [games]);
  const columns = width < 420 ? 1 : width < 700 ? 2 : width < 1000 ? 3 : 4;
  const rows = Math.ceil(games.length / columns);
  const height = Math.min(600, rows * rowHeight);
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 2);
  const lastRow = Math.min(rows, Math.ceil((scrollTop + height) / rowHeight) + 2);
  const visible = useMemo(() => games.slice(firstRow * columns, lastRow * columns), [games, firstRow, lastRow, columns]);
  return <div ref={container} role="list" aria-label="Games" className="relative overflow-y-auto" style={{ height }} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
    <div className="relative" style={{ height: rows * rowHeight }}>
      {visible.map((game, index) => {
        const position = firstRow * columns + index;
        return <div key={game.appid} role="listitem" className="absolute p-2" style={{ top: Math.floor(position / columns) * rowHeight, left: `${(position % columns) * 100 / columns}%`, width: `${100 / columns}%`, height: rowHeight }}>
          <div className="h-full text-center p-3 bg-neobrutal-blue border-4 border-black shadow-neobrutal-sm hover:bg-neobrutal-green transition-colors">
            {game.img_icon_url ? <div className="w-12 h-12 mx-auto mb-2 relative border-2 border-black">
              <Image src={`https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg`} alt={`${game.name} icon`} fill className="object-contain pixelated" sizes="48px" unoptimized />
            </div> : <div className="w-12 h-12 mx-auto mb-2 bg-neobrutal-pink border-2 border-black flex items-center justify-center"><span className="text-black text-xs font-bold">No Image</span></div>}
            <p className="font-bold text-sm mb-1 line-clamp-2 text-black">{game.name}</p>
            <p className="text-xs text-black font-bold">{formatPlaytime(game.playtime_forever)}</p>
          </div>
        </div>;
      })}
    </div>
  </div>;
}
