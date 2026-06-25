const DIRECT_MEDIA_EXTENSION = /\.(mp3|wav|ogg|opus|m4a|aac|flac|webm|mp4|m3u8)(\?|#|$)/i;

export function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** A direct file can go straight to mpv; all other HTTP URLs go through yt-dlp. */
export function isDirectMediaUrl(value: string): boolean {
  return isHttpUrl(value) && DIRECT_MEDIA_EXTENSION.test(value);
}
