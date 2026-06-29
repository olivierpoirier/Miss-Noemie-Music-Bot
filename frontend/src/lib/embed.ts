export type VideoEmbed = {
  provider: "youtube" | "twitch";
  label: string;
  src: string;
};

type EmbedOptions = {
  muted?: boolean;
};

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase();

  if (host === "youtu.be" || host.endsWith(".youtu.be")) {
    return url.pathname.split("/").filter(Boolean)[0] || null;
  }

  if (!(host === "youtube.com" || host.endsWith(".youtube.com"))) {
    return null;
  }

  if (url.pathname === "/watch") return url.searchParams.get("v");

  const parts = url.pathname.split("/").filter(Boolean);
  if (["shorts", "live", "embed"].includes(parts[0] || "")) {
    return parts[1] || null;
  }

  return null;
}

function youtubeEmbed(url: URL, muted: boolean): VideoEmbed | null {
  const videoId = youtubeVideoId(url);
  if (!videoId) return null;

  const params = new URLSearchParams({
    autoplay: "1",
    mute: muted ? "1" : "0",
    playsinline: "1",
    rel: "0",
  });

  return {
    provider: "youtube",
    label: "YouTube",
    src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params}`,
  };
}

function twitchEmbed(
  url: URL,
  parentHost: string,
  muted: boolean
): VideoEmbed | null {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  const params = new URLSearchParams({
    parent: parentHost || "localhost",
    autoplay: "true",
    muted: muted ? "true" : "false",
  });

  if (host === "clips.twitch.tv" && parts[0]) {
    params.set("clip", parts[0]);
  } else if (parts[0] === "videos" && parts[1]) {
    params.set("video", parts[1]);
  } else if (parts[0]) {
    params.set("channel", parts[0]);
  } else {
    return null;
  }

  return {
    provider: "twitch",
    label: "Twitch",
    src: `https://player.twitch.tv/?${params}`,
  };
}

/**
 * Only official browser players are embedded. Local mode keeps them muted so
 * the heard audio comes exclusively from the server-side virtual input.
 */
export function getVideoEmbed(
  value?: string | null,
  options: EmbedOptions = {}
): VideoEmbed | null {
  if (!value || value.startsWith("provider:")) return null;

  const muted = options.muted ?? true;
  const url = parseUrl(value);
  if (!url) return null;

  const host = url.hostname.toLowerCase();
  const parentHost = typeof window === "undefined" ? "localhost" : window.location.hostname;

  if (
    host === "youtu.be" ||
    host.endsWith(".youtu.be") ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com")
  ) {
    return youtubeEmbed(url, muted);
  }

  if (host === "twitch.tv" || host.endsWith(".twitch.tv")) {
    return twitchEmbed(url, parentHost, muted);
  }

  return null;
}
