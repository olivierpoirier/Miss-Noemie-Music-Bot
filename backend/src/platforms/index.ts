import { isDirectMediaUrl } from "./direct.js";
import {
  isSoundCloudSetUrl,
  isSoundCloudShortUrl,
  isSoundCloudUrl,
} from "./soundcloud.js";
import { isSpotifyUrl } from "./spotify.js";
import { isTwitchUrl, normalizeTwitchUrl } from "./twitch.js";
import {
  isYoutubePlaylistUrl,
  isYoutubeSearchUrl,
  isYoutubeUrl,
  normalizeYoutubeUrl,
} from "./youtube.js";

export type MediaPlatform =
  | "youtube"
  | "soundcloud"
  | "spotify"
  | "twitch"
  | "direct"
  | "generic";

export function getMediaPlatform(value: string): MediaPlatform {
  if (isYoutubeUrl(value)) return "youtube";
  if (isSoundCloudUrl(value)) return "soundcloud";
  if (isSpotifyUrl(value)) return "spotify";
  if (isTwitchUrl(value)) return "twitch";
  if (isDirectMediaUrl(value)) return "direct";
  return "generic";
}

export function normalizeMediaUrl(value: string): string {
  if (isYoutubeUrl(value)) return normalizeYoutubeUrl(value);
  if (isTwitchUrl(value)) return normalizeTwitchUrl(value);
  return value;
}

export function isPlaylistUrl(value: string): boolean {
  return (
    isYoutubePlaylistUrl(value) ||
    isSoundCloudSetUrl(value) ||
    isSpotifyUrl(value)
  );
}

export {
  isDirectMediaUrl,
  isSoundCloudSetUrl,
  isSoundCloudShortUrl,
  isSoundCloudUrl,
  isSpotifyUrl,
  isTwitchUrl,
  isYoutubePlaylistUrl,
  isYoutubeSearchUrl,
  isYoutubeUrl,
};
