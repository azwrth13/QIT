export interface Game {
  appid: number;
  name: string;
  img_icon_url?: string;
  playtime_forever?: number;
  genres?: string[];
}

export function formatPlaytime(minutes = 0): string {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function pickGame(games: Game[], random = Math.random): Game | null {
  return games.length ? games[Math.floor(random() * games.length)] : null;
}
