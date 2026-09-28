// Shared API response types

export interface SteamProfileResponse {
  response: {
    players: {
      steamid: string;
      profileurl: string;
      avatarfull: string;
      avatarmedium?: string;
      communityvisibilitystate?: number;
      profilestate?: number;
      personaname: string;
    }[];
  };
}

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

