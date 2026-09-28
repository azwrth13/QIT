export interface Game {
  appid: number;
  name: string;
  img_icon_url?: string;
  playtime_forever?: number;
  genres?: string[];
}

export interface LibraryStats {
  totalHours: number;
  unplayedCount: number;
  unplayedPercentage: number;
  mostPlayed: { game: Game; hours: number } | null;
}

export function getLibraryStats(games: Game[]): LibraryStats {
  const totalMinutes = games.reduce((total, game) => total + Math.max(0, game.playtime_forever || 0), 0);
  const unplayedCount = games.filter(game => !(game.playtime_forever && game.playtime_forever > 0)).length;
  const mostPlayedGame = games.reduce<Game | null>((mostPlayed, game) =>
    (game.playtime_forever || 0) > (mostPlayed?.playtime_forever || 0) ? game : mostPlayed, null);

  return {
    totalHours: Math.round(totalMinutes / 60),
    unplayedCount,
    unplayedPercentage: games.length ? Math.round((unplayedCount / games.length) * 100) : 0,
    mostPlayed: mostPlayedGame && (mostPlayedGame.playtime_forever || 0) > 0
      ? { game: mostPlayedGame, hours: Math.round((mostPlayedGame.playtime_forever || 0) / 60) }
      : null,
  };
}

export function formatPlaytime(minutes = 0): string {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function pickGame(games: Game[], random = Math.random): Game | null {
  return games.length ? games[Math.floor(random() * games.length)] : null;
}
