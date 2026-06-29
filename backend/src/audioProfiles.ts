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
    volume: 87,
    filters:
      "lavfi=[highpass=f=35,equalizer=f=220:t=q:w=0.9:g=-1.4,equalizer=f=2600:t=q:w=1.1:g=1.8,equalizer=f=4500:t=q:w=1.3:g=0.8,alimiter=level_in=1:level_out=0.96:limit=0.95:attack=4:release=80]",
  },
  xbox: {
    label: "Xbox",
    volume: 84,
    filters:
      "lavfi=[highpass=f=45,lowpass=f=16000,equalizer=f=250:t=q:w=1.0:g=-1.0,equalizer=f=3500:t=q:w=1.4:g=-1.5,acompressor=threshold=0.22:ratio=1.8:attack=25:release=180:makeup=1.5,alimiter=level_in=1:level_out=0.94:limit=0.92:attack=5:release=80]",
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
