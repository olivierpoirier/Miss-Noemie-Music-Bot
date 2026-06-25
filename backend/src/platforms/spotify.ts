export function isSpotifyUrl(value: string): boolean {
  if (value.startsWith("spotify:")) return true;

  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "spotify.com" || host.endsWith(".spotify.com");
  } catch {
    return false;
  }
}
