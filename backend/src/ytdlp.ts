import { spawn } from "child_process";
import play from "play-dl";
import { resolveSpotifyUrl, SpotifyResolverError } from "./spotify.js";

import { YTDLP_CONFIG } from "./config.js";
import { ProbeResult, ResolvedItem } from "./types.js";
import {
  getMediaPlatform,
  isDirectMediaUrl,
  isPlaylistUrl,
  isSpotifyUrl,
  isYoutubeSearchUrl,
  isYoutubeUrl,
  normalizeMediaUrl,
} from "./platforms/index.js";
import {
  YOUTUBE_MPV_SAFE_FORMAT,
  YOUTUBE_MPV_SAFE_PLAYER_CLIENT,
} from "./platforms/youtube.js";
import {
  normalizeAudioProfileName,
  type AudioProfileName,
} from "./audioProfiles.js";

/* ------------------------------------------------ */
/* CACHE                                            */
/* ------------------------------------------------ */

type CacheVal<T> = {
  v: T;
  exp: number;
};

const PROBE_CACHE = new Map<string, CacheVal<ProbeResult>>();
export type PlayableSource = {
  url: string;
  headers: string[];
  debugLabel?: string;
  ext?: string;
  formatId?: string;
  protocol?: string;
};

const DIRECT_CACHE = new Map<string, CacheVal<PlayableSource>>();
const FLAT_CACHE = new Map<string, CacheVal<ResolvedItem[]>>();

function cacheGet<K, V>(map: Map<K, CacheVal<V>>, key: K): V | undefined {
  const val = map.get(key);
  if (!val) return undefined;

  if (val.exp < Date.now()) {
    map.delete(key);
    return undefined;
  }

  return val.v;
}

function cacheSet<K, V>(map: Map<K, CacheVal<V>>, key: K, value: V): void {
  if (map.size >= YTDLP_CONFIG.cacheMax) {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }

  map.set(key, {
    v: value,
    exp: Date.now() + YTDLP_CONFIG.cacheTTL,
  });
}

/* ------------------------------------------------ */
/* URL HELPERS                                      */
/* ------------------------------------------------ */

export function normalizeUrl(url: string): string {
  return normalizeMediaUrl(url);
}

function buildYtDlpArgs(
  url: string,
  extraArgs: string[] = [],
  opts?: {
    useCookies?: boolean;
    youtubePlayerClient?: string | null;
  }
): string[] {
  const args = [...YTDLP_CONFIG.baseArgs];

  const useCookies =
    Boolean(opts?.useCookies) &&
    (YTDLP_CONFIG.hasCookies || Boolean(YTDLP_CONFIG.cookiesFromBrowser)) &&
    isYoutubeUrl(url) &&
    !isYoutubeSearchUrl(url);

  const youtubePlayerClient =
    opts && "youtubePlayerClient" in opts
      ? opts.youtubePlayerClient
      : YTDLP_CONFIG.youtubePlayerClients;

  if (isYoutubeUrl(url) && youtubePlayerClient) {
    args.push(
      "--extractor-args",
      `youtube:player_client=${youtubePlayerClient}`
    );
  }

  if (useCookies && YTDLP_CONFIG.cookiesPath) {
    args.push("--cookies", YTDLP_CONFIG.cookiesPath.replace(/\\/g, "/"));
  } else if (useCookies && YTDLP_CONFIG.cookiesFromBrowser) {
    args.push("--cookies-from-browser", YTDLP_CONFIG.cookiesFromBrowser);
  }

  return [...args, ...extraArgs];
}

function killProcessTree(proc: ReturnType<typeof spawn>) {
  try {
    if (process.platform === "win32" && proc.pid) {
      spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {}
}

function getSourceLabel(url: string): string {
  switch (getMediaPlatform(url)) {
    case "youtube":
      return "YouTube";
    case "spotify":
      return "Spotify";
    case "soundcloud":
      return "SoundCloud";
    case "twitch":
      return "Twitch";
    case "direct":
      return "Audio direct";
    default:
      return "Audio web";
  }
}

function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function buildFallbackThumb(title?: string, url?: string): string {
  const safeTitle = (title || getSourceLabel(url || "") || "Audio")
    .replace(/[<>&"]/g, "")
    .slice(0, 36);

  const source = getSourceLabel(url || "");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#111827"/>
          <stop offset="100%" stop-color="#1f2937"/>
        </linearGradient>
      </defs>
      <rect width="600" height="600" fill="url(#g)"/>
      <circle cx="300" cy="220" r="90" fill="#374151"/>
      <rect x="265" y="220" width="70" height="180" rx="22" fill="#d1d5db"/>
      <circle cx="320" cy="250" r="22" fill="#111827"/>
      <text x="300" y="470" text-anchor="middle" fill="#f9fafb" font-size="34" font-family="Arial, Helvetica, sans-serif" font-weight="700">
        ${safeTitle}
      </text>
      <text x="300" y="515" text-anchor="middle" fill="#9ca3af" font-size="22" font-family="Arial, Helvetica, sans-serif">
        ${source}
      </text>
    </svg>
  `;

  return svgToDataUri(svg);
}

function pickBestThumbnail(data: any, title?: string, url?: string): string {
  const direct =
    data?.thumbnail ||
    data?.thumbnails?.[data?.thumbnails?.length - 1]?.url ||
    data?.thumbnails?.[0]?.url ||
    null;

  return direct || buildFallbackThumb(title, url);
}

function buildEntryUrl(entry: any, playlistUrl: string): string | null {
  const raw =
    entry?.webpage_url ||
    entry?.original_url ||
    entry?.url ||
    entry?.webpage_url_basename ||
    null;

  if (typeof raw === "string" && /^https?:\/\//i.test(raw)) {
    return normalizeUrl(raw);
  }

  if (entry?.id && isYoutubeUrl(playlistUrl)) {
    return normalizeUrl(`https://www.youtube.com/watch?v=${entry.id}`);
  }

  return null;
}

function mapEntryToResolvedItem(entry: any, playlistUrl: string): ResolvedItem | null {
  const entryUrl = buildEntryUrl(entry, playlistUrl);
  if (!entryUrl) return null;

  const title =
    entry?.title ||
    entry?.track ||
    entry?.fulltitle ||
    entry?.uploader ||
    "Unknown";

  return {
    url: entryUrl,
    title,
    thumb: pickBestThumbnail(entry, title, entryUrl),
    durationSec: Number(entry?.duration) || 0,
  };
}

async function resolveYoutubePlaylistFast(
  normalized: string
): Promise<ResolvedItem[] | null> {
  if (!isYoutubeUrl(normalized) || !isPlaylistUrl(normalized)) return null;

  try {
    const playlist = await play.playlist_info(normalized, {
      incomplete: true,
    });

    const videos = await playlist.all_videos();

    const items = videos
      .map((video: any) => {
        const videoUrl =
          typeof video?.url === "string" && /^https?:\/\//i.test(video.url)
            ? video.url
            : video?.id
            ? `https://www.youtube.com/watch?v=${video.id}`
            : null;

        if (!videoUrl) return null;

        const title = video?.title || "YouTube";
        const thumb =
          video?.thumbnails?.slice?.(-1)?.[0]?.url ||
          video?.thumbnail?.url ||
          buildFallbackThumb(title, videoUrl);

        return {
          url: normalizeUrl(videoUrl),
          title,
          thumb,
          durationSec: Number(video?.durationInSec) || 0,
        };
      })
      .filter(Boolean)
      .slice(0, 200) as ResolvedItem[];

    if (!items.length) return null;

    console.log(`[playlist] YouTube fast resolver: ${items.length} titres`);
    return items;
  } catch (err) {
    console.warn("[playlist] YouTube fast resolver failed", err);
    return null;
  }
}

/* ------------------------------------------------ */
/* YT-DLP RUNNER                                    */
/* ------------------------------------------------ */

async function runYtDlp(
  url: string,
  extraArgs: string[],
  opts?: { useCookies?: boolean; youtubePlayerClient?: string | null }
): Promise<string> {
  const finalArgs = buildYtDlpArgs(url, extraArgs, opts);

  return new Promise((resolve, reject) => {
    console.log(`[yt-dlp] ${YTDLP_CONFIG.bin} ${finalArgs.join(" ")}`);

    const proc = spawn(YTDLP_CONFIG.bin, finalArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let out = "";
    let err = "";
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;

      killProcessTree(proc);

      if (err.trim()) {
        console.error("[yt-dlp timeout stderr]", err);
      }

      reject(new Error("yt-dlp timeout"));
    }, YTDLP_CONFIG.processTimeoutMs);

    proc.stdout.on("data", (d) => {
      out += d.toString();
    });

    proc.stderr.on("data", (d) => {
      err += d.toString();
    });

    proc.on("error", (spawnErr) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(spawnErr);
    });

    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve(out.trim());
      } else {
        if (err.trim()) {
          console.error("[yt-dlp error]", err);
        }
        reject(new Error(err || `Exit code ${code}`));
      }
    });
  });
}

/* ------------------------------------------------ */
/* SPOTIFY                                          */
/* ------------------------------------------------ */

export async function resolveSpotify(url: string): Promise<ResolvedItem[]> {
  try {
    return await resolveSpotifyUrl(url);
  } catch (err) {
    if (err instanceof SpotifyResolverError) {
      console.error("[spotify resolver error]", err.code, err.message);
    } else {
      console.error("[spotify resolver error]", err);
    }
    throw err;
  }
}

/* ------------------------------------------------ */
/* PLAYLIST RESOLVE                                 */
/* ------------------------------------------------ */

export async function resolveUrlToPlayableItems(
  url: string
): Promise<ResolvedItem[]> {
  const normalized = normalizeUrl(url);
  const cached = cacheGet(FLAT_CACHE, normalized);

  if (cached) return cached;

  if (isSpotifyUrl(normalized)) {
    const items = await resolveSpotify(normalized).then((list) =>
      list.map((it) => ({
        ...it,
        thumb: it.thumb || buildFallbackThumb(it.title, it.url),
      }))
    );

    cacheSet(FLAT_CACHE, normalized, items);
    return items;
  }

  if (isYoutubeSearchUrl(normalized)) {
    return [];
  }

  if (isPlaylistUrl(normalized)) {
    const fastYoutubePlaylist = await resolveYoutubePlaylistFast(normalized);
    if (fastYoutubePlaylist) {
      cacheSet(FLAT_CACHE, normalized, fastYoutubePlaylist);
      return fastYoutubePlaylist;
    }

    try {
      const json = await runYtDlp(
        normalized,
        [
          "-J",
          "--yes-playlist",
          "--flat-playlist",
          "--playlist-end",
          "200",
          normalized,
        ],
        { useCookies: true }
      );

      const data = JSON.parse(json);

      if (Array.isArray(data?.entries)) {
        const items = data.entries
          .map((entry: any) => mapEntryToResolvedItem(entry, normalized))
          .filter(Boolean)
          .slice(0, 200) as ResolvedItem[];

        const hydrated = items.map((it) => ({
          ...it,
          thumb: it.thumb || buildFallbackThumb(it.title, it.url),
        }));

        cacheSet(FLAT_CACHE, normalized, hydrated);
        return hydrated;
      }
    } catch (err) {
      console.error("[playlist resolve error]", err);
      throw new Error("Impossible d'analyser cette playlist rapidement.");
    }

    throw new Error("Cette playlist ne contient aucun titre exploitable.");
  }

  const single = await probeSingle(normalized);

  return [
    {
      ...single,
      thumb: single.thumb || buildFallbackThumb(single.title, normalized),
      url: normalized,
    },
  ];
}

/* ------------------------------------------------ */
/* PROBE (title + duration + thumb)                 */
/* ------------------------------------------------ */

export async function probeSingle(url: string): Promise<ProbeResult> {
  if (url.startsWith("provider:")) {
    const fallbackTitle = url.split(":").pop() || "Track";

    return {
      title: fallbackTitle,
      thumb: buildFallbackThumb(fallbackTitle, url),
      durationSec: 0,
    };
  }

  const normalized = normalizeUrl(url);
  const cached = cacheGet(PROBE_CACHE, normalized);

  if (cached) return cached;

  if (isYoutubeSearchUrl(normalized)) {
    return {
      title: "Recherche YouTube",
      thumb: buildFallbackThumb("Recherche", normalized),
      durationSec: 0,
    };
  }

  if (isDirectMediaUrl(normalized)) {
    const name = normalized.split("/").pop()?.split("?")[0] || "Audio direct";

    const res: ProbeResult = {
      title: decodeURIComponent(name),
      thumb: buildFallbackThumb(name, normalized),
      durationSec: 0,
    };

    cacheSet(PROBE_CACHE, normalized, res);
    return res;
  }

  if (play.yt_validate(normalized) === "video") {
    try {
      const info = await play.video_info(normalized);

      const res: ProbeResult = {
        title: info.video_details.title || "YouTube",
        thumb:
          info.video_details.thumbnails?.slice(-1)[0]?.url ||
          buildFallbackThumb(info.video_details.title || "YouTube", normalized),
        durationSec: info.video_details.durationInSec || 0,
      };

      cacheSet(PROBE_CACHE, normalized, res);
      return res;
    } catch {
      // fallback yt-dlp
    }
  }

  try {
    const json = await runYtDlp(
      normalized,
      ["--dump-single-json", "--no-playlist", normalized],
      { useCookies: true }
    );

    const data = JSON.parse(json);

    const title =
      data?.title ||
      data?.track ||
      data?.fulltitle ||
      data?.uploader ||
      getSourceLabel(normalized);

    const res: ProbeResult = {
      title,
      thumb: pickBestThumbnail(data, title, normalized),
      durationSec: Number(data?.duration) || 0,
    };

    cacheSet(PROBE_CACHE, normalized, res);
    return res;
  } catch {
    return {
      title: getSourceLabel(normalized),
      thumb: buildFallbackThumb(getSourceLabel(normalized), normalized),
      durationSec: 0,
    };
  }
}

/* ------------------------------------------------ */
/* DIRECT AUDIO URL                                 */
/* ------------------------------------------------ */

function toHeaderList(headers: unknown): string[] {
  if (!headers || typeof headers !== "object") return [];

  const blocked = new Set([
    "authorization",
    "cookie",
    "proxy-authorization",
  ]);

  const isSafeHeaderName = (name: string) =>
    /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);

  return Object.entries(headers as Record<string, unknown>)
    .filter(
      ([name, value]) =>
        isSafeHeaderName(name) &&
        !blocked.has(name.toLowerCase()) &&
        typeof value === "string" &&
        value.trim().length > 0 &&
        !/[\r\n]/.test(value)
    )
    .map(([name, value]) => `${name}: ${String(value).trim()}`);
}

function sourceFromYtDlpJson(
  data: any,
  debugLabel?: string
): PlayableSource | null {
  const requested = data?.requested_downloads?.[0];
  const requestedFormat = data?.requested_formats?.[0];

  const directUrl =
    requested?.url ||
    requestedFormat?.url ||
    data?.url ||
    null;

  if (typeof directUrl !== "string" || !/^https?:\/\//i.test(directUrl)) {
    return null;
  }

  return {
    url: directUrl,
    headers: toHeaderList(
      requested?.http_headers ||
        requestedFormat?.http_headers ||
        data?.http_headers
    ),
    debugLabel,
    ext: data?.ext || requested?.ext || requestedFormat?.ext,
    formatId:
      String(data?.format_id || requested?.format_id || requestedFormat?.format_id || "") ||
      undefined,
    protocol: data?.protocol || requested?.protocol || requestedFormat?.protocol,
  };
}

type PlaybackExtractionAttempt = {
  label: string;
  format: string;
  useCookies: boolean;
  youtubePlayerClient?: string | null;
};

const YOUTUBE_BALANCED_QUALITY_FORMAT =
  "best[ext=mp4][height<=720]/best[ext=mp4][height<=480]/18/bestaudio/best";

function getPlaybackExtractionAttempts(
  url: string,
  audioProfile?: AudioProfileName | null
): PlaybackExtractionAttempt[] {
  if (!isYoutubeUrl(url)) {
    return [
      {
        label: "generic-bestaudio-cookies",
        format: "bestaudio/best",
        useCookies: true,
      },
      {
        label: "generic-bestaudio-public",
        format: "bestaudio/best",
        useCookies: false,
      },
    ];
  }

  const safeClient =
    YTDLP_CONFIG.youtubeMpvSafePlayerClient ||
    YOUTUBE_MPV_SAFE_PLAYER_CLIENT;
  const safeFormat =
    YTDLP_CONFIG.youtubeMpvSafeFormat || YOUTUBE_MPV_SAFE_FORMAT;
  const profile = normalizeAudioProfileName(audioProfile);

  const qualityAttempts: PlaybackExtractionAttempt[] = [
    {
      label: "youtube-balanced-quality-cookies",
      format: YOUTUBE_BALANCED_QUALITY_FORMAT,
      useCookies: true,
      youtubePlayerClient: null,
    },
    {
      label: "youtube-balanced-quality-public",
      format: YOUTUBE_BALANCED_QUALITY_FORMAT,
      useCookies: false,
      youtubePlayerClient: null,
    },
  ];

  const bestAudioAttempts: PlaybackExtractionAttempt[] = [
    {
      label: "youtube-bestaudio-cookies",
      format: "bestaudio/best",
      useCookies: true,
      youtubePlayerClient: null,
    },
    {
      label: "youtube-bestaudio-public",
      format: "bestaudio/best",
      useCookies: false,
      youtubePlayerClient: null,
    },
  ];

  const safeAttempts: PlaybackExtractionAttempt[] = [
    {
      label: `youtube-mpv-safe-${safeClient}-cookies`,
      format: safeFormat,
      useCookies: true,
      youtubePlayerClient: safeClient,
    },
    {
      label: `youtube-mpv-safe-${safeClient}-public`,
      format: safeFormat,
      useCookies: false,
      youtubePlayerClient: safeClient,
    },
  ];

  const attempts =
    profile === "xbox"
      ? [
          safeAttempts[0],
          bestAudioAttempts[0],
          safeAttempts[1],
          bestAudioAttempts[1],
        ]
      : [
          qualityAttempts[0],
          bestAudioAttempts[0],
          safeAttempts[0],
          qualityAttempts[1],
          bestAudioAttempts[1],
          safeAttempts[1],
        ];

  const seen = new Set<string>();
  return attempts.filter((attempt) => {
    const key = [
      attempt.format,
      attempt.useCookies ? "cookies" : "public",
      attempt.youtubePlayerClient || "default",
    ].join("|");

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getPlayableSourceCacheKey(
  normalized: string,
  audioProfile?: AudioProfileName | null
): string {
  if (!isYoutubeUrl(normalized)) return normalized;
  return `${normalizeAudioProfileName(audioProfile)}:${normalized}`;
}

export async function getPlayableSource(
  url: string,
  audioProfile?: AudioProfileName | null
): Promise<PlayableSource | null> {
  if (url.startsWith("provider:")) return null;

  const normalized = normalizeUrl(url);

  if (isYoutubeSearchUrl(normalized)) {
    console.warn("[getPlayableSource] search URL refused:", normalized);
    return null;
  }

  if (isDirectMediaUrl(normalized)) {
    return { url: normalized, headers: [] };
  }

  const cacheKey = getPlayableSourceCacheKey(normalized, audioProfile);
  const cached = cacheGet(DIRECT_CACHE, cacheKey);
  if (cached) return cached;

  const tryOnce = async (
    attempt: PlaybackExtractionAttempt
  ): Promise<PlayableSource | null> => {
    try {
      const json = await runYtDlp(
        normalized,
        [
          "--dump-single-json",
          "-f",
          attempt.format,
          "--no-playlist",
          normalized,
        ],
        {
          useCookies: attempt.useCookies,
          youtubePlayerClient: attempt.youtubePlayerClient,
        }
      );

      const source = sourceFromYtDlpJson(JSON.parse(json), attempt.label);

      if (source) {
        cacheSet(DIRECT_CACHE, cacheKey, source);
        console.log(
          `[yt-dlp] playable source ${source.debugLabel || ""} ${
            source.formatId || ""
          } ${source.ext || ""}`.trim()
        );
      }

      return source;
    } catch (err) {
      console.warn(
        `[getPlayableSource] extractor failed (${attempt.label})`,
        err
      );
      return null;
    }
  };

  for (const attempt of getPlaybackExtractionAttempts(
    normalized,
    audioProfile
  )) {
    const source = await tryOnce(attempt);
    if (source) return source;
  }

  return null;
}

/** Backward-compatible URL-only accessor for callers that do not load MPV. */
export async function getDirectPlayableUrl(
  url: string,
  audioProfile?: AudioProfileName | null
): Promise<string | null> {
  return (await getPlayableSource(url, audioProfile))?.url || null;
}

export const resolvePlayable = getPlayableSource;
