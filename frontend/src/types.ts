export type Command =
  | "pause"
  | "resume"
  | "skip"
  | "skip_group"
  | "shuffle_queue"
  | "previous"
  | "repeat"
  | "random_mode"
  | "audio_profile"
  | "seek"
  | "seek_abs";

export type AudioProfileName = "balanced" | "xbox";

export type Control = {
  paused?: boolean;
  volume?: number;
  skipSeq?: number;
  repeat?: boolean;
  randomMode?: boolean;
  audioProfile?: AudioProfileName;
};

export type Now = {
  url?: string;
  title?: string;
  thumb?: string | null;
  addedBy?: string;
  startedAt?: number | null;
  group?: string;
  durationSec?: number | null;
  positionOffsetSec?: number;
  isBuffering: boolean;
  clientRequestId?: string;
};

export type QueueItem = {
  id: string;
  url: string;
  title?: string;
  thumb?: string | null;
  group?: string;
  addedBy?: string;
  status: "queued" | "playing" | "done" | "error" | "pending";
  createdAt: number;
  durationSec?: number;
  clientRequestId?: string;
};

export type QueueResponse = {
  ok: boolean;
  now: Now | null;
  queue: QueueItem[];
  history?: QueueItem[];
  control: Control | null;
  stats?: {
    totalQueued?: number;
    remainingTimeSec?: number;
  };
};
