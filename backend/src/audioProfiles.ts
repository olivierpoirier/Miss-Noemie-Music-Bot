import type { AudioProfileName } from "../../shared/contracts.js";
export type { AudioProfileName } from "../../shared/contracts.js";

export type AudioProfileConfig = {
  label: string;
  volume: number;
  filters: string;
};

export const DEFAULT_AUDIO_PROFILE: AudioProfileName = "balanced";

export const AUDIO_PROFILES: Record<AudioProfileName, AudioProfileConfig> = {
  balanced: {
    label: "Équilibré",
    volume: 90,
    // Preserve stereo and dynamics below the ceiling, with 1 dB of sample-peak
    // headroom before the virtual input/voice encoder. Disable limiter makeup
    // gain and flush its lookahead at EOF so short endings are not truncated.
    filters:
      "lavfi=[alimiter=level_in=1:level_out=1:limit=0.891251:attack=4:release=80:level=false:latency=true]",
  },
  xbox: {
    label: "Xbox",
    volume: 88,
    // Deliberate mono/voice-chat processing; use balanced for music fidelity.
    filters:
      "lavfi=[pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1,highpass=f=35,lowpass=f=17000,equalizer=f=250:t=q:w=1.0:g=0.8,equalizer=f=3500:t=q:w=1.4:g=-0.8,acompressor=threshold=0.28:ratio=1.45:attack=20:release=160:makeup=1.3,alimiter=level_in=1:level_out=0.95:limit=0.93:attack=5:release=80:level=false:latency=true]",
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
