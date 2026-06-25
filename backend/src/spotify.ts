import type { ResolvedItem } from "./types.js";

type SpotifyTokenCache = {
  accessToken: string;
  expiresAt: number;
} | null;

let tokenCache: SpotifyTokenCache = null;

type SpotifyImage = {
  url: string;
  height?: number;
  width?: number;
};

type SpotifyArtist = {
  name: string;
};

type SpotifyTrack = {
  id: string;
  name: string;
  duration_ms: number;
  artists: SpotifyArtist[];
  album?: {
    images?: SpotifyImage[];
  };
};

type SpotifyPlaylistItem = {
  track?: SpotifyTrack | null;
  item?: SpotifyTrack | null;
};

type SpotifyPlaylistResponse = {
  items: SpotifyPlaylistItem[];
  next: string | null;
};

type SpotifyAlbumTracksResponse = {
  items: SpotifyTrack[];
  next: string | null;
};

export class SpotifyResolverError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SpotifyResolverError";
    this.code = code;
  }
}

function getSpotifyConfig() {
  const clientId = (process.env.SPOTIFY_CLIENT_ID || "").trim();
  const clientSecret = (process.env.SPOTIFY_CLIENT_SECRET || "").trim();
  const refreshToken = (process.env.SPOTIFY_REFRESH_TOKEN || "").trim();

  if (!clientId || !clientSecret) {
    throw new SpotifyResolverError(
      "SPOTIFY_CONFIG_MISSING",
      "SPOTIFY_CLIENT_ID et SPOTIFY_CLIENT_SECRET sont requis dans .env"
    );
  }

  return { clientId, clientSecret, refreshToken };
}

async function refreshSpotifyAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 30_000) {
    return tokenCache.accessToken;
  }

  const { clientId, clientSecret, refreshToken } = getSpotifyConfig();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const requestToken = async (params: URLSearchParams) => {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SpotifyResolverError(
        "SPOTIFY_TOKEN_REQUEST_FAILED",
        `Spotify token request failed: ${res.status} ${text}`
      );
    }

    return (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
  };

  let data: { access_token: string; expires_in: number };

  if (refreshToken) {
    try {
      data = await requestToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        })
      );
    } catch (error) {
      // Public tracks, albums and public playlists work with client credentials.
      // This keeps normal Spotify links working when an old refresh token expires.
      console.warn("[spotify] refresh token failed; trying client credentials", error);
      data = await requestToken(
        new URLSearchParams({ grant_type: "client_credentials" })
      );
    }
  } else {
    data = await requestToken(
      new URLSearchParams({ grant_type: "client_credentials" })
    );
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return data.access_token;
}

async function spotifyGet<T>(url: string): Promise<T> {
  const accessToken = await refreshSpotifyAccessToken();

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");

    if (res.status === 404) {
      throw new SpotifyResolverError(
        "SPOTIFY_RESOURCE_NOT_FOUND",
        `Spotify GET failed: 404 ${text}`
      );
    }

    throw new SpotifyResolverError(
      "SPOTIFY_GET_FAILED",
      `Spotify GET failed: ${res.status} ${text}`
    );
  }

  return (await res.json()) as T;
}

function parseSpotifyUrl(
  url: string
): { type: "track" | "album" | "playlist"; id: string } | null {
  try {
    if (url.startsWith("spotify:")) {
      const parts = url.split(":");
      if (parts.length >= 3) {
        const type = parts[1];
        const id = parts[2];

        if (
          (type === "track" || type === "album" || type === "playlist") &&
          id
        ) {
          return { type, id };
        }
      }
      return null;
    }

    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);

    const playlistIndex = parts.findIndex((p) => p === "playlist");
    const trackIndex = parts.findIndex((p) => p === "track");
    const albumIndex = parts.findIndex((p) => p === "album");

    if (playlistIndex !== -1 && parts[playlistIndex + 1]) {
      return { type: "playlist", id: parts[playlistIndex + 1] };
    }

    if (trackIndex !== -1 && parts[trackIndex + 1]) {
      return { type: "track", id: parts[trackIndex + 1] };
    }

    if (albumIndex !== -1 && parts[albumIndex + 1]) {
      return { type: "album", id: parts[albumIndex + 1] };
    }

    return null;
  } catch {
    return null;
  }
}

function trackToResolvedItem(track: SpotifyTrack): ResolvedItem {
  const artist = track.artists?.map((a) => a.name).join(", ") || "";
  const query = artist ? `${artist} - ${track.name}` : track.name;

  return {
    url: `provider:spotify:${query}`,
    title: track.name,
    thumb: track.album?.images?.[0]?.url || null,
    durationSec: Math.floor((track.duration_ms || 0) / 1000),
  };
}

async function getAllPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = [];
  let nextUrl: string | null =
    `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=100`;

  while (nextUrl) {
    let data: SpotifyPlaylistResponse;

    try {
      data = await spotifyGet<SpotifyPlaylistResponse>(nextUrl);
    } catch (err) {
      if (err instanceof SpotifyResolverError && err.code === "SPOTIFY_RESOURCE_NOT_FOUND") {
        throw new SpotifyResolverError(
          "SPOTIFY_PLAYLIST_NOT_ACCESSIBLE",
          "Cette playlist Spotify n'est pas accessible via l'API classique (playlist officielle, radio inspirée, mix dynamique ou ressource non exposée)."
        );
      }
      throw err;
    }

    for (const entry of data.items || []) {
      const track = entry.item ?? entry.track ?? null;
      if (track?.id) {
        tracks.push(track);
      }
    }

    nextUrl = data.next;
  }

  return tracks;
}

async function getAllAlbumTracks(albumId: string): Promise<SpotifyTrack[]> {
  const album = await spotifyGet<{
    images?: SpotifyImage[];
    tracks: SpotifyAlbumTracksResponse;
  }>(`https://api.spotify.com/v1/albums/${albumId}`);

  const albumImages = album.images || [];
  const tracks: SpotifyTrack[] = [];
  let page: SpotifyAlbumTracksResponse | null = album.tracks;

  while (page) {
    for (const track of page.items || []) {
      tracks.push({
        ...track,
        album: {
          images: albumImages,
        },
      });
    }

    if (!page.next) break;

    const nextPage: SpotifyAlbumTracksResponse =
      await spotifyGet<SpotifyAlbumTracksResponse>(page.next);

    page = nextPage;
  }

  return tracks;
}

export async function resolveSpotifyUrl(url: string): Promise<ResolvedItem[]> {
  const parsed = parseSpotifyUrl(url);

  if (!parsed) {
    throw new SpotifyResolverError(
      "SPOTIFY_URL_INVALID",
      "URL Spotify invalide ou non supportée"
    );
  }

  console.log("[spotify parsed]", parsed);

  if (parsed.type === "track") {
    const track = await spotifyGet<SpotifyTrack>(
      `https://api.spotify.com/v1/tracks/${parsed.id}`
    );
    return [trackToResolvedItem(track)];
  }

  if (parsed.type === "album") {
    const tracks = await getAllAlbumTracks(parsed.id);
    return tracks.slice(0, 200).map(trackToResolvedItem);
  }

  if (parsed.type === "playlist") {
    const tracks = await getAllPlaylistTracks(parsed.id);
    return tracks.slice(0, 200).map(trackToResolvedItem);
  }

  return [];
}
