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

