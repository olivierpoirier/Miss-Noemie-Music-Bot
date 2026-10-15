import assert from "node:assert/strict";
import test from "node:test";
import {
  playbackPosition,
  playbackClockAt,
  clampPlaybackPosition,
  formatPlaybackTime,
} from "../../shared/playback.js";

const base = { isBuffering: false, durationSec: 300 };

test("shared clock uses the seek-adjusted anchor without adding its offset twice", () => {
  const clock = playbackClockAt(45, false, 100_000);
  assert.equal(playbackPosition({ ...base, ...clock }, false, 110_000), 55);
  assert.equal(playbackPosition({ ...base, startedAt: 0 }, false, 5_000), 5);
});

test("shared clock pauses and resumes without counting time spent paused", () => {
  const running = { ...base, ...playbackClockAt(30, false, 100_000) };
  const paused = {
    ...running,
    ...playbackClockAt(playbackPosition(running, false, 112_000), true, 112_000),
  };
  assert.equal(paused.startedAt, null);
  assert.equal(playbackPosition(paused, true, 400_000), 42);
  const resumed = { ...paused, ...playbackClockAt(paused.positionOffsetSec, false, 400_000) };
  assert.equal(playbackPosition(resumed, false, 405_000), 47);
});

test("shared clock freezes at the last confirmed position during buffering", () => {
  const buffering = { ...base, startedAt: 10_000, positionOffsetSec: 25, isBuffering: true };
  assert.equal(playbackPosition(buffering, false, 90_000), 25);
  const resumed = { ...buffering, ...playbackClockAt(25, false, 90_000), isBuffering: false };
  assert.equal(playbackPosition(resumed, false, 95_000), 30);
});

test("shared clock clamps a known duration while keeping live streams unbounded", () => {
  assert.equal(playbackPosition({ ...base, startedAt: 0 }, false, 400_000), 300);
  assert.equal(playbackPosition({ ...base, positionOffsetSec: 400 }, true, 400_000), 300);
  for (const durationSec of [undefined, null, 0, -1, NaN, Infinity]) {
    assert.equal(playbackPosition({ ...base, durationSec, startedAt: 0 }, false, 400_000), 400);
  }
});

test("shared clock preserves raw overflow when advancing a suspended demo queue", () => {
  assert.equal(playbackPosition({ ...base, startedAt: 0 }, false, 750_000, false), 750);
});

test("shared clock rejects invalid timestamps and positions without emitting NaN", () => {
  for (const startedAt of [undefined, null, NaN, Infinity]) {
    assert.equal(playbackPosition({ ...base, startedAt, positionOffsetSec: 12 }, false, 40_000), 12);
  }
  assert.equal(playbackPosition({ ...base, startedAt: 0, positionOffsetSec: 12 }, false, NaN), 12);
  assert.equal(playbackPosition({ ...base, startedAt: 50_000 }, false, 40_000), 0);
  for (const positionOffsetSec of [undefined, -1, NaN, Infinity]) {
    assert.equal(playbackPosition({ ...base, positionOffsetSec }, true), 0);
  }
  assert.equal(playbackPosition(null), 0);
});

test("shared clock normalizes seeks and represents an invalid clock as stopped", () => {
  assert.equal(clampPlaybackPosition(500, 120), 120);
  assert.equal(clampPlaybackPosition(-30, 120), 0);
  assert.equal(clampPlaybackPosition(Infinity), 0);
  assert.deepEqual(playbackClockAt(NaN, false, 5_000), { positionOffsetSec: 0, startedAt: 5_000 });
  assert.deepEqual(playbackClockAt(12, false, NaN), { positionOffsetSec: 12, startedAt: null });
  assert.deepEqual(playbackClockAt(Number.MAX_VALUE, false, 5_000), { positionOffsetSec: Number.MAX_VALUE, startedAt: null });
});

test("shared clock formats boundaries and malformed durations consistently", () => {
  assert.equal(formatPlaybackTime(59.99), "0:59");
  assert.equal(formatPlaybackTime(60), "1:00");
  assert.equal(formatPlaybackTime(3661.8), "1:01:01");
  for (const value of [undefined, null, NaN, Infinity, -1]) {
    assert.equal(formatPlaybackTime(value), "0:00");
  }
});

test("shared clock calculations leave the received playback snapshot unchanged", () => {
  const snapshot = Object.freeze({ ...base, ...playbackClockAt(45, false, 100_000) });
  const before = { ...snapshot };
  assert.equal(playbackPosition(snapshot, false, 110_000), 55);
  assert.equal(playbackPosition(snapshot, true, 110_000), 45);
  assert.deepEqual(snapshot, before);
});
