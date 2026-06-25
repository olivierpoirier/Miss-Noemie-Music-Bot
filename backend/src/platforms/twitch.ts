export function isTwitchUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === "twitch.tv" ||
      host.endsWith(".twitch.tv") ||
      host === "clips.twitch.tv"
    );
  } catch {
    return false;
  }
}

/** Keep Twitch URLs canonical for yt-dlp and for the client-side embed. */
export function normalizeTwitchUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() === "m.twitch.tv") {
      url.hostname = "www.twitch.tv";
    }
    return url.toString();
  } catch {
    return value;
  }
}
