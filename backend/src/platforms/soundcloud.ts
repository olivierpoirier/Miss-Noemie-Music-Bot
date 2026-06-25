export function isSoundCloudUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "soundcloud.com" || host.endsWith(".soundcloud.com");
  } catch {
    return false;
  }
}

export function isSoundCloudSetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return isSoundCloudUrl(value) && url.pathname.includes("/sets/");
  } catch {
    return false;
  }
}
