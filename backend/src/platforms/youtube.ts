function isYouTubeHost(host: string): boolean {
  return (
    host === "youtu.be" ||
    host.endsWith(".youtu.be") ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com")
  );
}

export const YOUTUBE_MPV_SAFE_PLAYER_CLIENT = "android";

/**
 * YouTube audio-only googlevideo URLs are currently fragile in MPV on some
 * videos/accounts. Format 18 is a progressive MP4 stream: MPV can discard the
 * video (`--video=no`) while still receiving an audio track reliably.
 */
export const YOUTUBE_MPV_SAFE_FORMAT =
  "18/best[ext=mp4][height<=360]/best[ext=mp4]/best/bestaudio/best";

export function isYoutubeUrl(value: string): boolean {
  try {
    return isYouTubeHost(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isYoutubeSearchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      isYouTubeHost(host) &&
      (url.pathname === "/results" ||
        (host === "music.youtube.com" && url.pathname === "/search"))
    );
  } catch {
    return false;
  }
}

export function isYoutubePlaylistUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return isYouTubeHost(url.hostname.toLowerCase()) && Boolean(url.searchParams.get("list"));
  } catch {
    return false;
  }
}

/**
 * Normalise les variantes de liens YouTube sans jamais enlever `list`.
 * Le précédent normaliseur réduisait `watch?v=…&list=…` à `watch?v=…`,
 * ce qui transformait silencieusement une playlist en une piste unique.
 */
export function normalizeYoutubeUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    if (!isYouTubeHost(host)) return value;

    const toWatchUrl = (videoId: string): string => {
      const normalized = new URL("https://www.youtube.com/watch");
      normalized.searchParams.set("v", videoId);

      for (const key of ["list", "index", "start", "t"]) {
        const param = url.searchParams.get(key);
        if (param) normalized.searchParams.set(key, param);
      }

      return normalized.toString();
    };

    if (host === "youtu.be" || host.endsWith(".youtu.be")) {
      const videoId = url.pathname.split("/").filter(Boolean)[0];
      return videoId ? toWatchUrl(videoId) : value;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if ((parts[0] === "shorts" || parts[0] === "live") && parts[1]) {
      return toWatchUrl(parts[1]);
    }

    if (parts[0] === "embed" && parts[1]) {
      return toWatchUrl(parts[1]);
    }

    return value;
  } catch {
    return value;
  }
}
