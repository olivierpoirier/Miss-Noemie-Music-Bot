import { ChildProcess } from "child_process";
import net from "net";
import type { GlobalState, QueueItem } from "../../shared/contracts.js";
export type {
  AudioProfileName,
  Command,
  Control,
  GlobalState,
  Now,
  QueueItem,
  QueueResponse,
} from "../../shared/contracts.js";

/* ------------------- MPV TYPES ------------------- */

export type MpvEvent =
  | { type: "file-loaded" }
  | { type: "playback-restart" }
  | { type: "end-file"; reason?: string; error?: string }
  | { type: "property-change"; name: string; data: unknown };

export interface MpvHandle {
  proc: ChildProcess;
  sock: net.Socket | null;

  send(cmd: Record<string, any>): Promise<void>;
  command(cmd: string, args?: any[]): Promise<void>;

  waitForPlaybackStart(timeoutMs?: number): Promise<void>;
  prepareForPlayback(): void;

  on(listener: (ev: MpvEvent) => void): void;
  off(listener: (ev: MpvEvent) => void): void;
  removeListener(listener: (ev: MpvEvent) => void): void;

  kill(): void;
}

/* ------------------- STATE INSTANCE ------------------- */

export const state: GlobalState = {
  control: {
    paused: false,
    skipSeq: 0,
    repeat: false,
    randomMode: false,
    audioProfile: "balanced",
  },
  now: null,
  queue: [],
  history: [],
};

export let playing: { item: QueueItem; handle: MpvHandle } | null = null;

export const setPlaying = (val: typeof playing) => {
  playing = val;
};

export const nextId = { current: 1 };

/* ------------------- MEDIA TYPES ------------------- */

export type ResolvedItem = {
  url: string;
  title: string;
  thumb?: string | null;
  durationSec: number;
};

export type ProbeResult = {
  title: string;
  thumb?: string | null;
  durationSec: number;
};
