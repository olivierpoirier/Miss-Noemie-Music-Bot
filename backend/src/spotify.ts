import type { ResolvedItem } from "./types.js";
import { recordDiagnostic, diagnosticErrorDetails } from "./diagnostics.js";
import { isSpotifyUrl } from "./platforms/spotify.js";

type SpotifyTokenCache = {
  accessToken: string;
  expiresAt: number;
} | null;

let tokenCache: SpotifyTokenCache = null;
let skipRefreshToken = false;
let tokenRequest: Promise<string> | null = null;
let rotatedRefreshToken: string | undefined;

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 5_000;
const MAX_ITEMS = 200;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The deadline includes reading the body; a server can stall after its headers. */
async function spotifyRequest(url: string, init?: RequestInit) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let result: { response: Response; body: string };

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      result = { response, body: await response.text() };
    } catch (error) {
      if (attempt >= MAX_RETRIES) {
        recordDiagnostic("SPOTIFY_REQUEST_FAILED", { ...diagnosticErrorDetails(error), ...(controller.signal.aborted ? { reason: "timeout" } : {}), attempt: attempt + 1 });
        throw new SpotifyResolverError(
          controller.signal.aborted ? "SPOTIFY_TIMEOUT" : "SPOTIFY_NETWORK_ERROR",
          controller.signal.aborted
            ? "Spotify ne répond pas dans le délai prévu. Réessaie dans un instant."
            : "Connexion à Spotify impossible. Vérifie la connexion réseau."
        );
      }
      recordDiagnostic("SPOTIFY_REQUEST_RETRY", { ...diagnosticErrorDetails(error), ...(controller.signal.aborted ? { reason: "timeout" } : {}), attempt: attempt + 1 });
      await delay(250 * 2 ** attempt);
      continue;
    } finally {
      clearTimeout(timeout);
    }

    const { response } = result;
    const retryAfter = Number(response.headers.get("retry-after"));
    const retryDelay = response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 250 * 2 ** attempt;
    if (
      attempt < MAX_RETRIES &&
      (response.status === 429 || response.status >= 500) &&
      retryDelay <= MAX_RETRY_DELAY_MS
    ) {
      recordDiagnostic("SPOTIFY_REQUEST_RETRY", { status: response.status, attempt: attempt + 1 });
      await delay(retryDelay);
      continue;
    }

    return result;
  }
}

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
  status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "SpotifyResolverError";
    this.code = code;
    this.status = status;
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

async function refreshSpotifyAccessToken(rejectedToken?: string): Promise<string> {
  if (rejectedToken && tokenCache?.accessToken === rejectedToken) {
    tokenCache = null;
  }
  if (tokenCache && Date.now() < tokenCache.expiresAt - 30_000) {
    return tokenCache.accessToken;
  }

  // Imports and background preloads must share a single refresh operation.
  if (tokenRequest) return tokenRequest;
  tokenRequest = requestSpotifyAccessToken().finally(() => { tokenRequest = null; });
  return tokenRequest;
}

async function requestSpotifyAccessToken(): Promise<string> {
  const { clientId, clientSecret, refreshToken } = getSpotifyConfig();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const requestToken = async (params: URLSearchParams) => {
    const { response: res, body } = await spotifyRequest("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    if (!res.ok) {
      const grantType = params.get("grant_type");
      const refreshTokenRevoked =
        grantType === "refresh_token" &&
        res.status === 400 &&
        /invalid_grant|revoked|refresh token/i.test(body);

      throw new SpotifyResolverError(
        refreshTokenRevoked
          ? "SPOTIFY_REFRESH_TOKEN_REVOKED"
          : "SPOTIFY_TOKEN_REQUEST_FAILED",
        `Spotify token request failed: ${res.status}`,
        res.status
      );
    }

    const data = JSON.parse(body) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };
    if (!data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new SpotifyResolverError("SPOTIFY_TOKEN_INVALID", "Réponse d'authentification Spotify invalide.");
    }
    if (data.refresh_token) rotatedRefreshToken = data.refresh_token;
    return data;
  };

  let data: { access_token: string; expires_in: number };

  if (refreshToken && !skipRefreshToken) {
    try {
      data = await requestToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: rotatedRefreshToken || refreshToken,
        })
      );
    } catch (error) {
      // Track and album metadata can still work with client credentials.
      // Playlist access may require the user's authorization and ownership.
      // A transient outage must not replace user authorization with an app
      // token for the next hour and make private playlists fail with 403.
      if (!(error instanceof SpotifyResolverError) || error.code !== "SPOTIFY_REFRESH_TOKEN_REVOKED") {
        throw error;
      }
      skipRefreshToken = true;
      recordDiagnostic("SPOTIFY_REFRESH_REVOKED", diagnosticErrorDetails(error));
      console.warn(
        "[spotify] SPOTIFY_REFRESH_TOKEN is revoked; using client credentials for track/album metadata. Reauthorize Spotify to access your playlists."
      );

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
  recordDiagnostic("SPOTIFY_TOKEN_REFRESHED");

  return data.access_token;
}

async function spotifyGet<T>(url: string): Promise<T> {
  const endpoint = new URL(url);
  if (endpoint.origin !== "https://api.spotify.com") {
    throw new SpotifyResolverError("SPOTIFY_URL_INVALID", "URL d'API Spotify invalide.");
  }
  // Client-credentials tokens have no user country. Spotify otherwise treats
  // content as unavailable; keep the former integration's FR default.
  const market = (process.env.SPOTIFY_MARKET || "FR").trim().toUpperCase();
  endpoint.searchParams.set("market", /^[A-Z]{2}$/.test(market) ? market : "FR");
  const requestUrl = endpoint.toString();

  let accessToken = await refreshSpotifyAccessToken();
  let result = await spotifyRequest(requestUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Retry a rejected token once, including when Spotify revokes it before expiry.
  if (result.response.status === 401) {
    recordDiagnostic("SPOTIFY_TOKEN_REJECTED", { status: 401 });
    accessToken = await refreshSpotifyAccessToken(accessToken);
    result = await spotifyRequest(requestUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }
  const { response: res, body } = result;

  if (!res.ok) {
    recordDiagnostic("SPOTIFY_REQUEST_FAILED", { status: res.status });
    if (res.status === 404) {
      throw new SpotifyResolverError(
        "SPOTIFY_RESOURCE_NOT_FOUND",
        "La ressource Spotify est introuvable ou inaccessible.",
        res.status
      );
    }

    if (res.status === 429) {
      throw new SpotifyResolverError(
        "SPOTIFY_RATE_LIMITED",
        "Spotify limite temporairement les requêtes ou le quota de l'application est atteint. Réessaie plus tard.",
        res.status
      );
    }

    throw new SpotifyResolverError(
      "SPOTIFY_GET_FAILED",
      `Spotify GET failed: ${res.status}`,
      res.status
    );
  }

  return JSON.parse(body) as T;
}

function parseSpotifyUrl(
  url: string
): { type: "track" | "album" | "playlist"; id: string } | null {
  try {
    if (!isSpotifyUrl(url)) return null;
    if (url.startsWith("spotify:")) {
      const parts = url.split(":");
      if (parts.length >= 3) {
        const type = parts[1];
        const id = parts[2];

        if (
          (type === "track" || type === "album" || type === "playlist") &&
          /^[a-zA-Z0-9]+$/.test(id || "")
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

    if (playlistIndex !== -1 && /^[a-zA-Z0-9]+$/.test(parts[playlistIndex + 1] || "")) {
      return { type: "playlist", id: parts[playlistIndex + 1] };
    }

    if (trackIndex !== -1 && /^[a-zA-Z0-9]+$/.test(parts[trackIndex + 1] || "")) {
      return { type: "track", id: parts[trackIndex + 1] };
    }

    if (albumIndex !== -1 && /^[a-zA-Z0-9]+$/.test(parts[albumIndex + 1] || "")) {
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
  const visited = new Set<string>();
  let scannedItems = 0;
  let nextUrl: string | null =
    `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=50`;

  while (nextUrl && scannedItems < MAX_ITEMS) {
    if (visited.has(nextUrl)) break;
    visited.add(nextUrl);
    let data: SpotifyPlaylistResponse;

    try {
      data = await spotifyGet<SpotifyPlaylistResponse>(nextUrl);
    } catch (err) {
      if (err instanceof SpotifyResolverError && (err.status === 404 || err.status === 403)) {
        throw new SpotifyResolverError(
          "SPOTIFY_PLAYLIST_NOT_ACCESSIBLE",
          "Playlist Spotify inaccessible. L'API exige une autorisation Spotify valide et, selon le mode de l'application, une playlist dont tu es propriétaire ou collaborateur. Vérifie aussi le quota et les utilisateurs autorisés de l'application.",
          err.status
        );
      }
      throw err;
    }

    if (!data.items?.length) break;
    for (const entry of data.items) {
      if (scannedItems++ >= MAX_ITEMS) break;
      const track = entry.item ?? entry.track ?? null;
      if (track?.id && track.name && tracks.length < MAX_ITEMS) {
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
  const visited = new Set<string>();

  while (page && tracks.length < MAX_ITEMS) {
    for (const track of page.items || []) {
      if (tracks.length >= MAX_ITEMS) break;
      tracks.push({
        ...track,
        album: {
          images: albumImages,
        },
      });
    }

    if (!page.next || tracks.length >= MAX_ITEMS || visited.has(page.next)) break;
    visited.add(page.next);

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
    return tracks.map(trackToResolvedItem);
  }

  if (parsed.type === "playlist") {
    const tracks = await getAllPlaylistTracks(parsed.id);
    return tracks.map(trackToResolvedItem);
  }

  return [];
}
