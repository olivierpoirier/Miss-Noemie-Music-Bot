/** Commands accepted by both the live player and the hosted demo. */
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
  paused: boolean;
  skipSeq: number;
  repeat: boolean;
  randomMode: boolean;
  audioProfile: AudioProfileName;
  volume?: number;
};

export type Now = {
  url?: string;
  title?: string;
  thumb?: string | null;
  addedBy?: string;
  /** Playback anchor: current position is (now - startedAt) / 1000. */
  startedAt?: number | null;
  group?: string;
  durationSec?: number | null;
  /** Frozen position while paused, buffering or awaiting a playback anchor. */
  positionOffsetSec?: number;
  isBuffering: boolean;
  clientRequestId?: string;
};

export type QueueItem = {
  id: string;
  url: string;
  /** Original provider page or Spotify query, retained when playback uses a match. */
  sourceUrl?: string;
  title?: string;
  thumb: string | null;
  group?: string;
  addedBy?: string;
  status: "queued" | "playing" | "done" | "error" | "pending";
  createdAt: number;
  durationSec?: number;
  clientRequestId?: string;
};

export type GlobalState = {
  control: Control;
  now: Now | null;
  queue: QueueItem[];
  history: QueueItem[];
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

export type DiagnosticTool = {
  path: string;
  version: string | null;
  checkedAt: string | null;
  status: "ok" | "warning" | "error" | "unchecked";
  ageDays: number | null;
  message: string;
};

export type DiagnosticDetails = {
  status?: number;
  exitCode?: number;
  durationMs?: number;
  attempt?: number;
  trackId?: string;
  reason?: string;
  platform?: string;
  stage?: string;
  activeUsers?: number;
  itemCount?: number;
  uptimeSec?: number;
  rssMB?: number;
  heapUsedMB?: number;
  lagMs?: number;
};

export type DiagnosticEvent = {
  runId?: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  category: string;
  code: string;
  message: string;
  details?: DiagnosticDetails;
};

export type DiagnosticSnapshot = {
  ok: true;
  timestamp: string;
  server: {
    uptimeSec: number;
    activeUsers: number;
    queued: number;
    idleShutdownMs: number;
  };
  player: {
    engineRunning: boolean;
    starting: boolean;
    loading: boolean;
    buffering: boolean;
    paused: boolean;
    retryCount: number;
  };
  audioRouting: { ready: boolean; degraded: boolean; message: string | null };
  tools: { ytDlp: DiagnosticTool; mpv?: DiagnosticTool };
  recentEvents: DiagnosticEvent[];
  logging: { enabled: boolean; available: boolean; droppedWrites?: number; runId?: string };
};
