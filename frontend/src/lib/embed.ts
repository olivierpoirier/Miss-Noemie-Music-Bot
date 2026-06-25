export type VideoEmbed = {
  provider: "youtube" | "twitch";
  label: string;
  src: string;
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

function youtubeEmbed(url: URL): VideoEmbed | null {
  const videoId = youtubeVideoId(url);
  if (!videoId) return null;

  const params = new URLSearchParams({
    autoplay: "1",
    mute: "1",
    playsinline: "1",
    rel: "0",
  });

  return {
    provider: "youtube",
    label: "YouTube",
    src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params}`,
  };
}

function twitchEmbed(url: URL, parentHost: string): VideoEmbed | null {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  const params = new URLSearchParams({
    parent: parentHost || "localhost",
    autoplay: "true",
    muted: "true",
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
 * Only official browser players are embedded. They are always muted: the audio
 * heard by players continues to come exclusively from the server-side virtual
 * input, never from the browser.
 */
export function getVideoEmbed(value?: string | null): VideoEmbed | null {
  if (!value || value.startsWith("provider:")) return null;

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
    return youtubeEmbed(url);
  }

  if (host === "twitch.tv" || host.endsWith(".twitch.tv")) {
    return twitchEmbed(url, parentHost);
  }

  return null;
}
