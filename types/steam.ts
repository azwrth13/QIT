// types/steam.ts
export interface SteamOwnedGamesResponse {
    response: {
      game_count: number;
      games: SteamGame[];
    };
  }
  
  export interface SteamGame {
    appid: number;
    name: string;
    playtime_2weeks?: number;
    playtime_forever?: number;
    img_icon_url?: string;
    img_logo_url?: string;
    has_community_visible_stats?: boolean;
  }
  