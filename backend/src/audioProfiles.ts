export type AudioProfileName = "balanced" | "xbox";

export type AudioProfileConfig = {
  label: string;
  volume: number;
  filters: string;
};

export const DEFAULT_AUDIO_PROFILE: AudioProfileName = "balanced";

export const AUDIO_PROFILES: Record<AudioProfileName, AudioProfileConfig> = {
  balanced: {
    label: "Équilibré",
    volume: 96,
    filters: "lavfi=[alimiter=limit=0.98]",
  },
  xbox: {
    label: "Xbox",
    volume: 88,
    filters:
      "lavfi=[highpass=f=55,lowpass=f=15000,equalizer=f=120:t=q:w=0.9:g=1.5,equalizer=f=3200:t=q:w=1.2:g=-1.8,acompressor=threshold=0.18:ratio=2.4:attack=20:release=220:makeup=2.5,alimiter=limit=0.92]",
  },
};

export function normalizeAudioProfileName(
  value?: string | null
): AudioProfileName {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "xbox" ? "xbox" : DEFAULT_AUDIO_PROFILE;
}

export function getAudioProfileConfig(
  profile?: string | null
): AudioProfileConfig {
  return AUDIO_PROFILES[normalizeAudioProfileName(profile)];
}
