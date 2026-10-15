import type { Now } from "./contracts.js";

export type PlaybackClock = Pick<Now, "startedAt" | "positionOffsetSec" | "durationSec" | "isBuffering">;

/** Unknown/zero durations denote an unbounded stream. Invalid positions become zero. */
export function clampPlaybackPosition(positionSec: number | null | undefined, durationSec?: number | null): number;

/** Disable duration clamping only when the demo needs elapsed time across tracks. */
export function playbackPosition(now: PlaybackClock | null | undefined, paused?: boolean, atMs?: number, clampToDuration?: boolean): number;

/** Anchor includes the position offset; paused clocks have no running timestamp. */
export function playbackClockAt(positionSec: number | null | undefined, paused?: boolean, atMs?: number): { positionOffsetSec: number; startedAt: number | null };

export function formatPlaybackTime(sec: number | null | undefined): string;
