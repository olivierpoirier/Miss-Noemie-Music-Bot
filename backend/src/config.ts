import path from "path";
import fs from "fs";
import { normalizeAudioProfileName } from "./audioProfiles.js";

const PLATFORM = process.platform;
const IS_WINDOWS = PLATFORM === "win32";
const IS_LINUX = PLATFORM === "linux";

function readEnv(key: string): string {
  return (process.env[key] || "").trim();
}

function envOrDefault(key: string, fallback: string): string {
  const value = readEnv(key);
  return value || fallback;
}

function envEnabled(key: string, defaultValue = true): boolean {
  const value = readEnv(key).toLowerCase();

  if (!value) return defaultValue;

  return !["0", "false", "no", "off"].includes(value);
}

function envNumber(key: string, fallback: number): number {
  const value = Number(readEnv(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const APP_CONFIG = {
  PORT: 4000,
  platform: PLATFORM,
  isWindows: IS_WINDOWS,
  isLinux: IS_LINUX,
};

function findCookiesPath(): string | null {
  const explicitPath = readEnv("YTDLP_COOKIES_PATH");
  const candidates = [
    explicitPath,
    path.resolve(process.cwd(), "cookies.txt"),
    path.resolve(process.cwd(), "www.youtube.com_cookies.txt"),
    path.resolve(process.cwd(), "backend", "cookies.txt"),
  ].filter(Boolean);

  return (
    candidates.find((candidate) => {
      try {
        return fs.existsSync(candidate) && fs.statSync(candidate).size > 0;
      } catch {
        return false;
      }
    }) || null
  );
}

const COOKIES_PATH = findCookiesPath();
const HAS_COOKIES = Boolean(COOKIES_PATH);

function findBundledYtDlpBinary(): string | null {
  const binaryName = IS_WINDOWS ? "yt-dlp.exe" : "yt-dlp";
  const candidates = [
    path.resolve(
      process.cwd(),
      "node_modules",
      "yt-dlp-exec",
      "bin",
      binaryName
    ),
    path.resolve(
      process.cwd(),
      "backend",
      "node_modules",
      "yt-dlp-exec",
      "bin",
      binaryName
    ),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const BUNDLED_YTDLP_BIN = findBundledYtDlpBinary();

if (HAS_COOKIES) {
  console.log(`✅ Fichier cookies trouvé à : ${COOKIES_PATH}`);
} else {
  console.warn(`⚠️ Fichier cookies introuvable à : ${COOKIES_PATH}`);
}

const YTDLP_JS_RUNTIME = readEnv("YTDLP_JS_RUNTIME");

export const AUDIO_CONFIG = {
  windowsVoicemeeterPath: envOrDefault(
    "VOICEMEETER_PATH",
    "C:\\Program Files (x86)\\VB\\Voicemeeter\\voicemeeterpro.exe"
  ),

  windowsVoicemeeterExeName: envOrDefault(
    "VOICEMEETER_EXE_NAME",
    "voicemeeterpro.exe"
  ),

  // Device Windows par défaut pour mpv -> VoiceMeeter
  windowsMpvAudioDevice: envOrDefault(
    "WINDOWS_MPV_AUDIO_DEVICE",
    "wasapi/{422c5f03-d063-4b65-b529-c54272b9bac9}"
  ),

  // Linux : création automatique d'un sink/source virtuel
  linuxEnableVirtualSink: envEnabled("LINUX_ENABLE_VIRTUAL_SINK", true),
  linuxVirtualSinkName: envOrDefault("LINUX_VIRTUAL_SINK_NAME", "xmbot_sink"),
  linuxVirtualSinkDescription: envOrDefault(
    "LINUX_VIRTUAL_SINK_DESCRIPTION",
    "XM-Bot-Virtual-Sink"
  ),
};

export const MPV_CONFIG = {
  bin: envOrDefault("MPV_BIN", "mpv"),
  defaultAudioProfile: normalizeAudioProfileName(
    envOrDefault("AUDIO_PROFILE", "balanced")
  ),

  baseArgs: [
    "--video=no",
    "--input-terminal=no",
    "--term-osd=no",
    "--load-scripts=no",
    "--ytdl=no",

    // Qualité audio
    "--audio-format=float",
    "--audio-channels=stereo",
    "--audio-samplerate=48000",
    "--audio-resample-filter-size=24",
    "--audio-resample-cutoff=0",
    "--audio-resample-linear=yes",
    "--gapless-audio=yes",
    "--audio-pitch-correction=yes",

    // Robustesse
    `--audio-buffer=${envOrDefault("MPV_AUDIO_BUFFER_SEC", "2.0")}`,
    "--cache=yes",
    `--demuxer-max-bytes=${envOrDefault("MPV_DEMUXER_MAX_BYTES", "256MiB")}`,
    `--demuxer-readahead-secs=${envNumber("MPV_DEMUXER_READAHEAD_SEC", 10)}`,
    "--audio-stream-silence=yes",
    "--idle=yes",
    "--keep-open=no",
  ],
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",

  ipcConnectTimeoutMs: 5000,
  globalStartTimeoutMs: 20000,
};

export const PLAYER_CONFIG = {
  preloadAhead: Math.min(envNumber("PLAYER_PRELOAD_AHEAD", 3), 6),
  preloadCacheMax: Math.min(envNumber("PLAYER_PRELOAD_CACHE_MAX", 8), 16),
};

export const YTDLP_CONFIG = {
  // yt-dlp-exec downloads a tested local binary during npm install. Prefer it
  // to an assumed global PATH install, while still allowing an explicit update.
  bin: envOrDefault(
    "YTDLP_BIN",
    BUNDLED_YTDLP_BIN || (IS_WINDOWS ? "yt-dlp.exe" : "yt-dlp")
  ),

  baseArgs: [
    ...(envEnabled("YTDLP_FORCE_IPV4", false) ? ["--force-ipv4"] : []),
    "--no-progress",
    "--no-warnings",
    "--ignore-config",
    ...(YTDLP_JS_RUNTIME ? ["--js-runtimes", YTDLP_JS_RUNTIME] : []),
  ],

  cacheTTL: 600_000,
  cacheMax: 512,
  processTimeoutMs: 60_000,
  cookiesPath: COOKIES_PATH,
  hasCookies: HAS_COOKIES,
  cookiesFromBrowser: readEnv("YTDLP_COOKIES_FROM_BROWSER"),
  // Leave this empty by default: yt-dlp selects the most compatible client.
  // It can be overridden for an environment that needs a specific client.
  youtubePlayerClients: readEnv("YTDLP_YOUTUBE_PLAYER_CLIENTS"),
  youtubeMpvSafePlayerClient: envOrDefault(
    "YTDLP_YOUTUBE_MPV_SAFE_CLIENT",
    "android"
  ),
  youtubeMpvSafeFormat: envOrDefault(
    "YTDLP_YOUTUBE_MPV_SAFE_FORMAT",
    "18/best[ext=mp4][height<=360]/best[ext=mp4]/best/bestaudio/best"
  ),

  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || "",
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
    refreshToken: process.env.SPOTIFY_REFRESH_TOKEN || "",
  },
};
