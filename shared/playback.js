// startedAt already includes a seek/resume offset; never add that offset twice.
export function clampPlaybackPosition(positionSec, durationSec) {
  const position = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
  return Number.isFinite(durationSec) && durationSec > 0
    ? Math.min(position, durationSec)
    : position;
}

export function playbackPosition(now, paused = false, atMs = Date.now(), clampToDuration = true) {
  if (!now) return 0;

  const frozen = paused || now.isBuffering ||
    !Number.isFinite(now.startedAt) || !Number.isFinite(atMs);
  const position = frozen
    ? now.positionOffsetSec
    : (atMs - now.startedAt) / 1000;

  return clampPlaybackPosition(position, clampToDuration ? now.durationSec : undefined);
}

export function playbackClockAt(positionSec, paused = false, atMs = Date.now()) {
  const positionOffsetSec = clampPlaybackPosition(positionSec);
  const anchor = atMs - positionOffsetSec * 1000;
  return {
    positionOffsetSec,
    startedAt: paused || !Number.isFinite(anchor) ? null : anchor,
  };
}

export function formatPlaybackTime(sec) {
  const seconds = Math.floor(clampPlaybackPosition(sec));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}
