import { spawn } from "child_process";
import play from "play-dl";
import { performance } from "node:perf_hooks";
import { recordBackendMetric } from "./metrics.js";
import { recordDiagnostic, diagnosticErrorDetails } from "./diagnostics.js";
import { resolveSpotifyUrl } from "./spotify.js";

import { MPV_CONFIG, YTDLP_CONFIG } from "./config.js";
import { ProbeResult, ResolvedItem } from "./types.js";
import {
  getMediaPlatform,
  isDirectMediaUrl,
  isPlaylistUrl,
  isSoundCloudUrl,
  isSoundCloudSetUrl,
  isSoundCloudShortUrl,
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
  expiresAt?: number;
};

const DIRECT_CACHE = new Map<string, CacheVal<PlayableSource>>();
const DIRECT_PENDING = new Map<string, Promise<PlayableSource | null>>();
const FLAT_CACHE = new Map<string, CacheVal<ResolvedItem[]>>();
const YOUTUBE_SEARCH_CACHE = new Map<string, CacheVal<ResolvedItem>>();
const SEARCH_PENDING = new Map<string, Promise<ResolvedItem | null>>();
const SOUNDCLOUD_EXPAND_CACHE = new Map<string, CacheVal<string>>();

const PLAY_DL_TIMEOUT_MS = 10_000;
const MAX_PLAY_DL_PENDING = 3;
let playDlPending = 0;

async function withDeadline<T>(operation: () => Promise<T>, label: string): Promise<T> {
  // play-dl does not expose cancellation of its HTTPS requests. A race timeout
  // alone leaves the request alive; retain its slot until it really settles so
  // repeated outages cannot accumulate an unbounded number of open requests.
  if (playDlPending >= MAX_PLAY_DL_PENDING) throw new Error("Metadata provider unavailable");
  playDlPending++;
  const pending = Promise.resolve().then(operation).then(
    (result) => { playDlPending--; return result; },
    (error) => { playDlPending--; throw error; }
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timeout`)), PLAY_DL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function cacheGet<K, V>(map: Map<K, CacheVal<V>>, key: K): V | undefined {
  const val = map.get(key);
  if (!val) return undefined;

  if (val.exp < Date.now()) {
    map.delete(key);
    return undefined;
  }

  return val.v;
}

function cacheSet<K, V>(map: Map<K, CacheVal<V>>, key: K, value: V, expiresAt?: number): void {
  if (map.size >= YTDLP_CONFIG.cacheMax) {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }

  map.set(key, {
    v: value,
    exp: expiresAt ?? Date.now() + YTDLP_CONFIG.cacheTTL,
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

  const youtubePlayerClient = opts?.youtubePlayerClient === undefined
    ? YTDLP_CONFIG.youtubePlayerClients
    : opts.youtubePlayerClient;

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
      }).on("error", () => {});
    } else if (proc.pid) {
      // The runner starts a separate group, including JS runtimes/helpers.
      try { process.kill(-proc.pid, "SIGKILL"); }
      catch { proc.kill("SIGKILL"); }
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

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;

  const lowered = trimmed.toLowerCase();
  if (lowered === "unknown" || lowered === "null" || lowered === "undefined") {
    return null;
  }

  return trimmed;
}

function titleFromUrl(value?: string | null): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (!last || last === "sets") return null;

    const decoded = decodeURIComponent(last)
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return decoded || null;
  } catch {
    return null;
  }
}

function pickEntryTitle(
  entry: any,
  entryUrl: string | null,
  playlistUrl: string
): string {
  const explicit =
    cleanText(entry?.title) ||
    cleanText(entry?.track) ||
    cleanText(entry?.fulltitle) ||
    cleanText(entry?.alt_title) ||
    cleanText(entry?.display_id);

  if (explicit) return explicit;

  const urlTitle = titleFromUrl(entryUrl) || titleFromUrl(playlistUrl);
  const artist =
    cleanText(entry?.uploader) ||
    cleanText(entry?.artist) ||
    cleanText(entry?.creator);

  if (artist && urlTitle) return `${artist} - ${urlTitle}`;
  return urlTitle || artist || getSourceLabel(entryUrl || playlistUrl);
}

function buildEntryUrl(entry: any, playlistUrl: string): string | null {
  const raw =
    entry?.webpage_url ||
    entry?.permalink_url ||
    entry?.original_url ||
    entry?.url ||
    entry?.webpage_url_basename ||
    null;

  if (typeof raw === "string" && /^https?:\/\//i.test(raw)) {
    return normalizeUrl(raw);
  }

  if (typeof raw === "string" && /^\/[^/]/.test(raw)) {
    return normalizeUrl(new URL(raw, "https://soundcloud.com").toString());
  }

  if (typeof raw === "string" && /^soundcloud\.com\//i.test(raw)) {
    return normalizeUrl(`https://${raw}`);
  }

  if (entry?.id && isYoutubeUrl(playlistUrl)) {
    return normalizeUrl(`https://www.youtube.com/watch?v=${entry.id}`);
  }

  return null;
}

function mapEntryToResolvedItem(entry: any, playlistUrl: string): ResolvedItem | null {
  const entryUrl = buildEntryUrl(entry, playlistUrl);
  if (!entryUrl) return null;

  const title = pickEntryTitle(entry, entryUrl, playlistUrl);

  return {
    url: entryUrl,
    title,
    thumb: pickBestThumbnail(entry, title, entryUrl),
    durationSec: Number(entry?.duration) || 0,
  };
}

function mapEntriesToResolvedItems(
  data: any,
  playlistUrl: string
): ResolvedItem[] {
  if (!Array.isArray(data?.entries)) return [];

  return data.entries
    .map((entry: any) => mapEntryToResolvedItem(entry, playlistUrl))
    .filter(Boolean)
    .slice(0, 200) as ResolvedItem[];
}

function mapSingleDataToResolvedItem(data: any, url: string): ResolvedItem {
  const normalized = buildEntryUrl(data, url) || normalizeUrl(url);
  const title = pickEntryTitle(data, normalized, url);

  return {
    url: normalized,
    title,
    thumb: pickBestThumbnail(data, title, normalized),
    durationSec: Number(data?.duration) || 0,
  };
}

function mapYoutubeSearchResult(data: any, query: string): ResolvedItem | null {
  // yt-dlp's `url` is often a short-lived googlevideo stream, whereas
  // play-dl's `url` is a stable video page. Matches queued for later playback
  // and persisted across restarts must always retain the stable page.
  let url = [data?.webpage_url, data?.original_url, data?.url].find((value) =>
    typeof value === "string" && /^https?:\/\//i.test(value) && isYoutubeUrl(value) && !isYoutubeSearchUrl(value)
  ) as string | undefined;
  if (!url && typeof data?.id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(data.id)) {
    url = `https://www.youtube.com/watch?v=${data.id}`;
  }

  if (!url) return null;

  const normalized = normalizeUrl(url);
  const title = data?.title || query;

  return {
    url: normalized,
    title,
    thumb: pickBestThumbnail(data, title, normalized),
    durationSec: Number(data?.durationInSec) || Number(data?.duration) || 0,
  };
}

export function buildSoundCloudYoutubeQuery(
  title?: string | null,
  url?: string | null
): string {
  const fallbackTitle = title?.trim() || "";
  const cleanedTitle = fallbackTitle
    .replace(/^stream\s+/i, "")
    .replace(/\s*\|\s*listen online for free on soundcloud\s*$/i, "")
    .replace(/\s+on\s+soundcloud\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const byMatch = cleanedTitle.match(/^(.+?)\s+by\s+(.+?)$/i);
  if (byMatch?.[1] && byMatch?.[2] && !cleanedTitle.includes(" - ")) {
    return `${byMatch[2].trim()} - ${byMatch[1].trim()}`;
  }

  if (cleanedTitle && cleanedTitle.toLowerCase() !== "soundcloud") return cleanedTitle;

  if (!url) return fallbackTitle || "SoundCloud";

  try {
    const parsed = new URL(url);
    const parts = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((part) =>
        decodeURIComponent(part)
          .replace(/[-_]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter(Boolean);

    if (parts.length >= 2) return `${parts[0]} - ${parts[1]}`;
    return parts[0] || fallbackTitle || "SoundCloud";
  } catch {
    return fallbackTitle || "SoundCloud";
  }
}

async function fetchJsonWithTimeout<T>(
  url: string,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  let status: number | undefined;
  let ok = false;

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": MPV_CONFIG.userAgent,
      },
    });

    status = res.status;

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json() as T;
    ok = true;
    return data;
  } finally {
    clearTimeout(timeout);
    recordBackendMetric("fetch-json", performance.now() - startedAt, ok, {
      platform: getMediaPlatform(url), status, timeout: controller.signal.aborted,
    });
  }
}

async function expandSoundCloudShortUrl(normalized: string): Promise<string> {
  if (!isSoundCloudShortUrl(normalized)) return normalized;

  const cached = cacheGet(SOUNDCLOUD_EXPAND_CACHE, normalized);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    YTDLP_CONFIG.soundCloudMetadataTimeoutMs
  );
  const startedAt = performance.now();

  try {
    const res = await fetch(normalized, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": MPV_CONFIG.userAgent,
      },
    });

    await res.body?.cancel().catch(() => {});
    if (!res.ok) throw Object.assign(new Error("SoundCloud redirect unavailable"), { status: res.status });

    const finalUrl =
      typeof res.url === "string" && isSoundCloudUrl(res.url)
        ? normalizeUrl(res.url)
        : normalized;

    recordBackendMetric("soundcloud-expand", performance.now() - startedAt, true, {
      changed: finalUrl !== normalized,
      status: res.status,
    });

    // A failed/unresolved short link is transient; caching it would mask a
    // provider recovery for the entire metadata cache lifetime.
    if (finalUrl !== normalized && !isSoundCloudShortUrl(finalUrl)) {
      cacheSet(SOUNDCLOUD_EXPAND_CACHE, normalized, finalUrl);
    }
    return finalUrl;
  } catch (err) {
    recordBackendMetric("soundcloud-expand", performance.now() - startedAt, false, {
      changed: false,
    });
    recordDiagnostic("MEDIA_RESOLUTION_FALLBACK", { ...diagnosticErrorDetails(err), platform: "soundcloud", stage: "shortlink" });
    return normalized;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveSoundCloudOEmbed(
  normalized: string
): Promise<ProbeResult | null> {
  const expanded = await expandSoundCloudShortUrl(normalized);
  const candidates =
    expanded === normalized ? [normalized] : [expanded, normalized];

  for (const candidate of candidates) {
    try {
      const data = await fetchJsonWithTimeout<{
        title?: string;
        thumbnail_url?: string;
      }>(
        `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(
          candidate
        )}`,
        YTDLP_CONFIG.soundCloudMetadataTimeoutMs
      );

      const title = cleanText(data.title);
      if (!title) continue;

      return {
        title,
        thumb: cleanText(data.thumbnail_url) || buildFallbackThumb(title, candidate),
        durationSec: 0,
      };
    } catch (err) {
      recordDiagnostic("MEDIA_RESOLUTION_FALLBACK", { ...diagnosticErrorDetails(err), platform: "soundcloud", stage: "metadata" });
    }
  }

  return null;
}

export type YoutubeSearchOptions = {
  expectedDurationSec?: number | null;
  limit?: number;
  bypassCache?: boolean;
};

function normalizeSearchText(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function scoreYoutubeCandidate(
  item: ResolvedItem,
  query: string,
  expectedDurationSec?: number | null
): number {
  let score = 0;
  const title = item.title || "";
  const titleTokens = new Set(normalizeSearchText(title));
  const queryTokens = normalizeSearchText(query);

  for (const token of queryTokens) {
    if (titleTokens.has(token)) score += 4;
  }

  const loweredTitle = title.toLowerCase();
  const loweredQuery = query.toLowerCase();
  const noisyTerms = [
    "live",
    "remix",
    "cover",
    "karaoke",
    "instrumental",
    "lyrics",
    "paroles",
    "slowed",
    "sped up",
    "nightcore",
    "reaction",
  ];

  for (const term of noisyTerms) {
    const containsTerm = (text: string) => (` ${normalizeSearchText(text).join(" ")} `).includes(` ${term} `);
    if (containsTerm(loweredTitle) && !containsTerm(loweredQuery)) {
      score -= 12;
    }
  }

  if (loweredTitle.includes("official audio")) score += 8;
  if (loweredTitle.includes("official video")) score += 5;
  if (loweredTitle.includes("topic")) score += 4;

  if (expectedDurationSec && item.durationSec) {
    const diff = Math.abs(item.durationSec - expectedDurationSec);
    if (diff <= 2) score += 30;
    else if (diff <= 5) score += 22;
    else if (diff <= 10) score += 12;
    else if (diff <= 20) score += 4;
    else score -= Math.min(30, Math.floor(diff / 5));
  }

  return score;
}

function pickBestYoutubeSearchResult(
  candidates: ResolvedItem[],
  query: string,
  expectedDurationSec?: number | null
): ResolvedItem | null {
  if (!candidates.length) return null;

  return candidates
    .map((item) => ({
      item,
      score: scoreYoutubeCandidate(item, query, expectedDurationSec),
    }))
    .sort((a, b) => b.score - a.score)[0]?.item ?? null;
}

export async function searchYoutubeVideo(
  query: string,
  options: YoutubeSearchOptions = {}
): Promise<ResolvedItem | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const limit = Math.max(1, Math.min(Math.floor(options.limit || 5), 10));
  const startedAt = performance.now();
  const cacheKey = [
    normalizeSearchText(trimmed).join(" "),
    limit,
    Math.round(options.expectedDurationSec || 0),
  ].join("|");
  const resolutionKey = options.bypassCache ? `${cacheKey}\0fresh` : cacheKey;
  if (options.bypassCache) {
    YOUTUBE_SEARCH_CACHE.delete(cacheKey);
    SEARCH_PENDING.delete(cacheKey);
  }
  const cached = cacheGet(YOUTUBE_SEARCH_CACHE, cacheKey);
  if (cached) {
    recordBackendMetric("youtube-search", performance.now() - startedAt, true, {
      source: "cache", limit, expectedDuration: Boolean(options.expectedDurationSec),
    });
    return { ...cached };
  }
  const pending = SEARCH_PENDING.get(resolutionKey);
  if (pending) {
    const result = await pending;
    return result ? { ...result } : null;
  }

  const task = (async (): Promise<ResolvedItem | null> => {
    const finish = (
      item: ResolvedItem | null,
      source: "play-dl" | "yt-dlp" | "none"
    ): ResolvedItem | null => {
      recordBackendMetric("youtube-search", performance.now() - startedAt, Boolean(item), {
        source, limit, expectedDuration: Boolean(options.expectedDurationSec),
      });
      if (!item) {
        recordDiagnostic("MEDIA_RESOLUTION_FAILED", { platform: "youtube", stage: "search", reason: "unavailable" });
        return null;
      }
      if (SEARCH_PENDING.get(resolutionKey) === task) {
        cacheSet(YOUTUBE_SEARCH_CACHE, cacheKey, { ...item }, Date.now() + YTDLP_CONFIG.searchCacheTTLMs);
      }
      return { ...item };
    };
    try {
      const results = await withDeadline(() => play.search(trimmed, {
        limit, source: { youtube: "video" },
      }), "YouTube search");
      const candidates = results.map((result) => mapYoutubeSearchResult(result, trimmed))
        .filter((item): item is ResolvedItem => Boolean(item));
      const item = pickBestYoutubeSearchResult(candidates, trimmed, options.expectedDurationSec);
      if (item) return finish(item, "play-dl");
    } catch (err) {
      recordDiagnostic("MEDIA_RESOLUTION_FALLBACK", { ...diagnosticErrorDetails(err), platform: "youtube", stage: "search" });
    }

    try {
      const searchUrl = `ytsearch${limit}:${trimmed}`;
      const json = await runYtDlp(searchUrl, ["--dump-single-json", "--no-playlist", searchUrl], { useCookies: true });
      const data = JSON.parse(json);
      const entries: unknown[] = Array.isArray(data?.entries) ? data.entries : [data];
      const candidates = entries.map((entry) => mapYoutubeSearchResult(entry, trimmed))
        .filter((item): item is ResolvedItem => Boolean(item));
      const item = pickBestYoutubeSearchResult(candidates, trimmed, options.expectedDurationSec);
      if (item) return finish(item, "yt-dlp");
    } catch { /* The runner records classified process failures. */ }
    return finish(null, "none");
  })();
  SEARCH_PENDING.set(resolutionKey, task);
  try {
    const result = await task;
    return result ? { ...result } : null;
  } finally {
    if (SEARCH_PENDING.get(resolutionKey) === task) SEARCH_PENDING.delete(resolutionKey);
  }
}

async function resolveSoundCloudItems(
  normalized: string
): Promise<ResolvedItem[] | null> {
  if (!isSoundCloudUrl(normalized)) return null;
  if (!isSoundCloudSetUrl(normalized) && !isSoundCloudShortUrl(normalized)) {
    return null;
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
      {
        useCookies: false,
        timeoutMs: YTDLP_CONFIG.soundCloudMetadataTimeoutMs,
      }
    );

    const data = JSON.parse(json);
    const items = mapEntriesToResolvedItems(data, normalized);

    if (Array.isArray(data?.entries)) {
      return items.map((it) => ({
        ...it,
        thumb: it.thumb || buildFallbackThumb(it.title, it.url),
      }));
    }

    return [mapSingleDataToResolvedItem(data, normalized)];
  } catch (err) {
    recordDiagnostic("MEDIA_RESOLUTION_FALLBACK", { ...diagnosticErrorDetails(err), platform: "soundcloud", stage: "playlist" });
    return null;
  }
}

async function resolveYoutubePlaylistFast(
  normalized: string
): Promise<ResolvedItem[] | null> {
  if (!isYoutubeUrl(normalized) || !isPlaylistUrl(normalized)) return null;

  try {
    const videos = await withDeadline(async () => {
      const playlist = await play.playlist_info(normalized, {
      incomplete: true,
      });

      // all_videos() fetched an entire large playlist before the 200-item cap.
      if (playlist.total_videos < 200) await playlist.fetch(200 - playlist.total_videos);
      return Array.from({ length: playlist.total_pages }, (_, page) => playlist.page(page + 1)).flat();
    }, "YouTube playlist");

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

    return items;
  } catch (err) {
    recordDiagnostic("MEDIA_RESOLUTION_FALLBACK", { ...diagnosticErrorDetails(err), platform: "youtube", stage: "playlist" });
    return null;
  }
}

/* ------------------------------------------------ */
/* YT-DLP RUNNER                                    */
/* ------------------------------------------------ */

async function runYtDlp(
  url: string,
  extraArgs: string[],
  opts?: { useCookies?: boolean; youtubePlayerClient?: string | null; timeoutMs?: number }
): Promise<string> {
  const finalArgs = buildYtDlpArgs(url, extraArgs, opts);
  const startedAt = Date.now();
  const record = (ok: boolean, data: Record<string, unknown> = {}) => {
    recordBackendMetric("yt-dlp", Date.now() - startedAt, ok, {
      platform: getMediaPlatform(url),
      mode: extraArgs.includes("-J") ? "playlist" : extraArgs.includes("--dump-single-json") ? "json" : "other",
      ...data,
    });
  };

  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_CONFIG.bin, finalArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    let out = "";
    let err = "";
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;

      killProcessTree(proc);
      record(false, { timeout: true });
      recordDiagnostic("YTDLP_TIMEOUT", { durationMs: Date.now() - startedAt, reason: "timeout", platform: getMediaPlatform(url) });

      reject(new Error("yt-dlp timeout"));
    }, opts?.timeoutMs ?? YTDLP_CONFIG.processTimeoutMs);

    proc.stdout.on("data", (d) => {
      if (finished) return;
      out += d.toString();
      if (out.length > 32 * 1024 * 1024) {
        finished = true;
        clearTimeout(timeout);
        killProcessTree(proc);
        recordDiagnostic("YTDLP_PROCESS_FAILED", { durationMs: Date.now() - startedAt, platform: getMediaPlatform(url) });
        record(false, { outputLimit: true });
        reject(new Error("yt-dlp output exceeded 32 MiB"));
      }
    });

    proc.stderr.on("data", (d) => {
      if (!finished) err = (err + d.toString()).slice(-65_536);
    });

    proc.on("error", (spawnErr) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      recordDiagnostic("YTDLP_PROCESS_FAILED", { ...diagnosticErrorDetails(spawnErr), durationMs: Date.now() - startedAt, platform: getMediaPlatform(url) });
      record(false, { spawnError: true });
      reject(Object.assign(new Error("Impossible de démarrer yt-dlp."), { code: (spawnErr as NodeJS.ErrnoException).code }));
    });

    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);

      if (code === 0) {
        record(true);
        resolve(out.trim());
      } else {
        record(false, { exitCode: code });
        const details = diagnosticErrorDetails(new Error(err));
        recordDiagnostic("YTDLP_PROCESS_FAILED", { ...details, ...(code !== null ? { exitCode: code } : {}), durationMs: Date.now() - startedAt, platform: getMediaPlatform(url) });
        // stderr often contains private media URLs, cookie paths or queries.
        // Preserve only the classified status when propagating to callers.
        reject(Object.assign(new Error("L'extraction yt-dlp a échoué."), { status: details.status, code: details.reason }));
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
    recordDiagnostic("MEDIA_RESOLUTION_FAILED", { ...diagnosticErrorDetails(err), platform: "spotify", stage: "metadata" });
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

  const soundCloudItems = await resolveSoundCloudItems(normalized);
  if (soundCloudItems?.length) {
    cacheSet(FLAT_CACHE, normalized, soundCloudItems);
    return soundCloudItems;
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

      const items = mapEntriesToResolvedItems(data, normalized);

      if (items.length) {
        const hydrated = items.map((it) => ({
          ...it,
          thumb: it.thumb || buildFallbackThumb(it.title, it.url),
        }));

        cacheSet(FLAT_CACHE, normalized, hydrated);
        return hydrated;
      }
    } catch (err) {
      recordDiagnostic("MEDIA_RESOLUTION_FAILED", { ...diagnosticErrorDetails(err), platform: getMediaPlatform(normalized), stage: "playlist" });
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
    let title = name;
    try { title = decodeURIComponent(name); } catch {}

    const res: ProbeResult = {
      title,
      thumb: buildFallbackThumb(name, normalized),
      durationSec: 0,
    };

    cacheSet(PROBE_CACHE, normalized, res);
    return res;
  }

  if (isSoundCloudUrl(normalized)) {
    const oembed = await resolveSoundCloudOEmbed(normalized);
    if (oembed) {
      cacheSet(PROBE_CACHE, normalized, oembed);
      return oembed;
    }
  }

  if (play.yt_validate(normalized) === "video") {
    try {
      const info = await withDeadline(() => play.video_info(normalized), "YouTube metadata");

      const res: ProbeResult = {
        title: info.video_details.title || "YouTube",
        thumb:
          info.video_details.thumbnails?.slice(-1)[0]?.url ||
          buildFallbackThumb(info.video_details.title || "YouTube", normalized),
        durationSec: info.video_details.durationInSec || 0,
      };

      cacheSet(PROBE_CACHE, normalized, res);
      return res;
    } catch (err) {
      recordDiagnostic("MEDIA_RESOLUTION_FALLBACK", { ...diagnosticErrorDetails(err), platform: "youtube", stage: "metadata" });
      // fallback yt-dlp
    }
  }

  try {
    const json = await runYtDlp(
      normalized,
      ["--dump-single-json", "--no-playlist", normalized],
      {
        useCookies: true,
        timeoutMs: isSoundCloudUrl(normalized)
          ? YTDLP_CONFIG.soundCloudMetadataTimeoutMs
          : undefined,
      }
    );

    const data = JSON.parse(json);

    const dataUrl = buildEntryUrl(data, normalized) || normalized;
    const title = pickEntryTitle(data, dataUrl, normalized);

    const res: ProbeResult = {
      title,
      thumb: pickBestThumbnail(data, title, dataUrl),
      durationSec: Number(data?.duration) || 0,
    };

    cacheSet(PROBE_CACHE, normalized, res);
    return res;
  } catch (err) {
    recordDiagnostic("MEDIA_RESOLUTION_FAILED", { ...diagnosticErrorDetails(err), platform: getMediaPlatform(normalized), stage: "metadata" });
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
  const candidates = [
    ...(data?.requested_formats || []),
    ...(data?.requested_downloads || []),
    data,
  ].filter((format) => typeof format?.url === "string" && /^https?:\/\//i.test(format.url));
  // A custom selector can return separate video/audio formats. The first
  // requested format is often video-only and would leave MPV silent.
  const selected = candidates.find((format) => format.vcodec === "none" && format.acodec && format.acodec !== "none")
    || candidates.find((format) => format.acodec !== "none");
  if (!selected) return null;
  const directUrl = selected.url as string;

  let expiresAt = Date.now() + YTDLP_CONFIG.cacheTTL;
  const params = new URL(directUrl).searchParams;
  const signedExpiry = Number(params.get("expire") || params.get("expires"));
  if (Number.isFinite(signedExpiry) && signedExpiry > 0) {
    // Leave time to hand a signed URL to MPV before the origin rejects it.
    expiresAt = Math.min(expiresAt, signedExpiry * 1000 - 30_000);
  }

  return {
    url: directUrl,
    headers: toHeaderList({ ...data?.http_headers, ...selected.http_headers }),
    debugLabel,
    ext: selected.ext || data?.ext,
    formatId: String(selected.format_id || data?.format_id || "") || undefined,
    protocol: selected.protocol || data?.protocol,
    expiresAt,
  };
}

type PlaybackExtractionAttempt = {
  label: string;
  format: string;
  useCookies: boolean;
  youtubePlayerClient?: string | null;
};

export type PlayableSourceOptions = {
  bypassCache?: boolean;
  skipDebugLabels?: string[];
};

const YOUTUBE_AUDIO_FIRST_FORMAT =
  "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best";

const YOUTUBE_BALANCED_QUALITY_FORMAT =
  "best[ext=mp4][height<=720]/best[ext=mp4][height<=480]/18/bestaudio/best";

function getPlaybackExtractionAttempts(
  url: string,
  audioProfile?: AudioProfileName | null
): PlaybackExtractionAttempt[] {
  if (isSoundCloudUrl(url)) {
    return [{ label: "soundcloud-bestaudio", format: "bestaudio/best", useCookies: false }];
  }

  if (!isYoutubeUrl(url)) {
    return [
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
  const defaultClient = YTDLP_CONFIG.youtubePlayerClients || null;

  const qualityAttempts: PlaybackExtractionAttempt[] = [
    {
      label: "youtube-balanced-quality-cookies",
      format: YOUTUBE_BALANCED_QUALITY_FORMAT,
      useCookies: true,
      youtubePlayerClient: defaultClient,
    },
    {
      label: "youtube-balanced-quality-public",
      format: YOUTUBE_BALANCED_QUALITY_FORMAT,
      useCookies: false,
      youtubePlayerClient: defaultClient,
    },
  ];

  const bestAudioAttempts: PlaybackExtractionAttempt[] = [
    {
      label: "youtube-bestaudio-cookies",
      format: YOUTUBE_AUDIO_FIRST_FORMAT,
      useCookies: true,
      youtubePlayerClient: defaultClient,
    },
    {
      label: "youtube-bestaudio-public",
      format: YOUTUBE_AUDIO_FIRST_FORMAT,
      useCookies: false,
      youtubePlayerClient: defaultClient,
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
          bestAudioAttempts[0],
          safeAttempts[0],
          safeAttempts[1],
          bestAudioAttempts[1],
        ]
      : [
          bestAudioAttempts[0],
          safeAttempts[0],
          qualityAttempts[0],
          qualityAttempts[1],
          bestAudioAttempts[1],
          safeAttempts[1],
        ];

  const seen = new Set<string>();
  return attempts.filter((attempt) => {
    // Cookies only apply when available for this platform. Compare effective
    // arguments to avoid running the very same failed extraction twice.
    const key = buildYtDlpArgs(url, ["-f", attempt.format], attempt).join("\0");

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

/** Drop an expired/rejected signed URL before retrying playback. */
export function invalidatePlayableSource(
  url: string,
  audioProfile?: AudioProfileName | null
): void {
  const normalized = normalizeUrl(url);
  const keys = audioProfile == null && isYoutubeUrl(normalized)
    ? ["balanced", "xbox"].map((profile) => `${profile}:${normalized}`)
    : [getPlayableSourceCacheKey(normalized, audioProfile)];
  for (const key of keys) {
    DIRECT_CACHE.delete(key);
    for (const pendingKey of DIRECT_PENDING.keys()) {
      if (pendingKey === key || pendingKey.startsWith(`${key}\0`)) {
        DIRECT_PENDING.delete(pendingKey);
      }
    }
  }
}

export async function getPlayableSource(
  url: string,
  audioProfile?: AudioProfileName | null,
  options: PlayableSourceOptions = {}
): Promise<PlayableSource | null> {
  if (url.startsWith("provider:")) return null;

  const normalized = normalizeUrl(url);

  if (isYoutubeSearchUrl(normalized)) {
    recordDiagnostic("MEDIA_RESOLUTION_FAILED", { platform: "youtube", stage: "search", reason: "unavailable" });
    return null;
  }

  if (isDirectMediaUrl(normalized)) {
    return { url: normalized, headers: [] };
  }

  const cacheKey = getPlayableSourceCacheKey(normalized, audioProfile);
  const skippedLabels = new Set(options.skipDebugLabels || []);
  const resolutionKey = options.bypassCache || skippedLabels.size
    ? `${cacheKey}\0fresh:${[...skippedLabels].sort().join(",")}`
    : cacheKey;
  if (options.bypassCache) {
    DIRECT_CACHE.delete(cacheKey);
    // An older extraction must not restore the rejected signed URL in cache.
    DIRECT_PENDING.delete(cacheKey);
  }
  const cached = cacheGet(DIRECT_CACHE, cacheKey);
  if (cached && !skippedLabels.has(cached.debugLabel || "")) return cached;
  const pending = DIRECT_PENDING.get(resolutionKey);
  if (pending) return pending;

  const task: Promise<PlayableSource | null> = (async () => {
    const deadline = Date.now() + Math.min(
      YTDLP_CONFIG.processTimeoutMs,
      isSoundCloudUrl(normalized)
        ? YTDLP_CONFIG.soundCloudPlaybackTimeoutMs
        : YTDLP_CONFIG.processTimeoutMs
    );

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
            timeoutMs: Math.max(1, Math.min(20_000, deadline - Date.now())),
          }
        );

        const source = sourceFromYtDlpJson(JSON.parse(json), attempt.label);

        if (source && (source.expiresAt ?? Infinity) <= Date.now()) {
          // A successful extraction can already contain an unusable signed
          // URL. Try the next extraction strategy before handing it to MPV.
          recordDiagnostic("YTDLP_PROCESS_FAILED", { platform: getMediaPlatform(normalized), reason: "unavailable" });
          return null;
        }

        if (source) {
          recordDiagnostic("YTDLP_SOURCE_RESOLVED", { platform: getMediaPlatform(normalized) });
          if (DIRECT_PENDING.get(resolutionKey) === task && (source.expiresAt ?? 0) > Date.now()) {
            cacheSet(DIRECT_CACHE, cacheKey, source, source.expiresAt);
          }
        }

        return source;
      } catch (err) {
        // Process errors are already classified by the runner. JSON/shape
        // errors must also remain visible without logging raw output.
        recordDiagnostic("YTDLP_PROCESS_FAILED", { ...diagnosticErrorDetails(err), platform: getMediaPlatform(normalized) });
        return null;
      }
    };

    for (const attempt of getPlaybackExtractionAttempts(
      normalized,
      audioProfile
    )) {
      if (Date.now() >= deadline) break;
      if (skippedLabels.has(attempt.label)) continue;
      const source = await tryOnce(attempt);
      if (source) return source;
    }

    recordDiagnostic("MEDIA_RESOLUTION_FAILED", { platform: getMediaPlatform(normalized), stage: "extraction", reason: "unavailable" });
    return null;
  })();

  DIRECT_PENDING.set(resolutionKey, task);
  try {
    return await task;
  } finally {
    if (DIRECT_PENDING.get(resolutionKey) === task) DIRECT_PENDING.delete(resolutionKey);
  }
}

/** Backward-compatible URL-only accessor for callers that do not load MPV. */
export async function getDirectPlayableUrl(
  url: string,
  audioProfile?: AudioProfileName | null
): Promise<string | null> {
  return (await getPlayableSource(url, audioProfile))?.url || null;
}

export const resolvePlayable = getPlayableSource;
