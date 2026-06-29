import play from "play-dl";
import {
  state,
  playing,
  setPlaying,
  QueueItem,
  MpvHandle,
  MpvEvent,
  nextId,
} from "./types.js";
import {
  startMpv,
  mpvPause,
  mpvLoadFile,
  mpvStop,
  mpvSetLoopFile,
  mpvSeekAbsolute,
  mpvSetHttpHeaders,
  mpvSetAudioProfile,
} from "./mpv.js";
import {
  getPlayableSource,
  normalizeUrl,
  resolvePlayable,
  type PlayableSource,
} from "./ytdlp.js";
import { MPV_CONFIG, PLAYER_CONFIG } from "./config.js";
import { isVirtualAudioRoutingReady } from "./utils.js";
import type { AudioProfileName } from "./audioProfiles.js";

let globalMpvHandle: MpvHandle | null = null;
let isLooping = false;
let currentListener: ((ev: MpvEvent) => void) | null = null;

/* ------------------- PRELOAD SYSTEM ------------------- */

type PreloadedSource = {
  audioProfile: AudioProfileName;
  source: PlayableSource;
};

type PreloadingSource = {
  audioProfile: AudioProfileName;
  task: Promise<PlayableSource | null>;
};

let preloaded = new Map<string, PreloadedSource>();
let preloading = new Map<string, PreloadingSource>();
let preloadWorkerRunning = false;

function computeCurrentPosition(): number {
  if (!state.now) return 0;

  if (state.control.paused || state.now.isBuffering || !state.now.startedAt) {
    return state.now.positionOffsetSec || 0;
  }

  return Math.max(0, (Date.now() - state.now.startedAt) / 1000);
}

function pushToHistory(item: QueueItem): void {
  const snapshot: QueueItem = {
    ...item,
    status: "done",
  };

  state.history = [
    snapshot,
    ...state.history.filter((h) => h.id !== item.id),
  ].slice(0, 200);
}

function trimPreloadCache(): void {
  const usableIds = new Set(
    state.queue
      .filter((q) => q.status === "queued" || q.status === "playing")
      .map((q) => q.id)
  );

  for (const itemId of preloaded.keys()) {
    if (!usableIds.has(itemId)) {
      preloaded.delete(itemId);
    }
  }

  while (preloaded.size > PLAYER_CONFIG.preloadCacheMax) {
    const first = preloaded.keys().next();
    if (first.done) break;
    preloaded.delete(first.value);
  }
}

function getUpcomingPreloadCandidates(): QueueItem[] {
  const preloadLimit = Math.min(
    PLAYER_CONFIG.preloadAhead,
    PLAYER_CONFIG.preloadCacheMax
  );

  const queued = state.queue.filter((q) => q.status === "queued");

  if (state.control.randomMode) {
    const candidates = queued
      .filter(
        (item) =>
          !isPreloadedForCurrentProfile(item.id) && !preloading.has(item.id)
      )
      .sort(() => Math.random() - 0.5);

    return candidates.slice(0, preloadLimit);
  }

  return queued
    .slice(0, preloadLimit)
    .filter(
      (item) =>
        !isPreloadedForCurrentProfile(item.id) && !preloading.has(item.id)
    );
}

function isPreloadedForCurrentProfile(itemId: string): boolean {
  return preloaded.get(itemId)?.audioProfile === state.control.audioProfile;
}

async function resolveItemToSource(
  item: QueueItem
): Promise<PlayableSource | null> {
  const spotifyOk = await resolveSpotifyItem(item);
  if (!spotifyOk) return null;

  if (item.url.startsWith("provider:")) return null;

  return getPlayableSource(normalizeUrl(item.url), state.control.audioProfile);
}

async function preloadTrack(item: QueueItem): Promise<PlayableSource | null> {
  if (!item) return null;
  const ready = preloaded.get(item.id);
  if (ready?.audioProfile === state.control.audioProfile) return ready.source;
  if (ready) preloaded.delete(item.id);
  const pending = preloading.get(item.id);
  if (pending?.audioProfile === state.control.audioProfile) {
    return pending.task;
  }
  if (pending) return null;
  if (item.status !== "queued") return null;

  const audioProfile = state.control.audioProfile;
  const task = (async () => {
    try {
      const source = await resolveItemToSource(item);

      if (source && item.status === "queued") {
        preloaded.set(item.id, { audioProfile, source });
        trimPreloadCache();
        console.log(`[player] ⚡ Préchargé: ${item.title || item.url}`);
      }

      return source;
    } catch (err) {
      console.warn("[player] preload failed", err);
      return null;
    } finally {
      preloading.delete(item.id);
    }
  })();

  preloading.set(item.id, { audioProfile, task });
  return task;
}

function schedulePreloadWorker(): void {
  if (preloadWorkerRunning) return;

  preloadWorkerRunning = true;

  void (async () => {
    try {
      trimPreloadCache();

      const candidates = getUpcomingPreloadCandidates();

      for (const next of candidates) {
        await preloadTrack(next);
      }
    } finally {
      preloadWorkerRunning = false;
      trimPreloadCache();
    }
  })();
}

export function warmUpcomingTracks(): void {
  schedulePreloadWorker();
}

async function consumePreloaded(
  item: QueueItem
): Promise<PlayableSource | null> {
  const ready = preloaded.get(item.id);
  if (ready?.audioProfile === state.control.audioProfile) {
    preloaded.delete(item.id);
    return ready.source;
  }

  if (ready) {
    preloaded.delete(item.id);
    return null;
  }

  const pending = preloading.get(item.id);
  if (!pending) return null;

  const out = await pending.task;
  preloaded.delete(item.id);
  return pending.audioProfile === state.control.audioProfile ? out : null;
}

function clearPreloadForItem(itemId: string): void {
  preloaded.delete(itemId);
  preloading.delete(itemId);
}

function resetNowState(): void {
  state.now = null;
  setPlaying(null);
}

/* ------------------- MPV ------------------- */

export async function ensureMpvRunning(): Promise<MpvHandle> {
  if (!isVirtualAudioRoutingReady()) {
    throw new Error(
      "Le routage audio virtuel n'est pas prÃªt : MPV ne sera pas dÃ©marrÃ© sur la sortie systÃ¨me."
    );
  }

  if (globalMpvHandle && globalMpvHandle.proc.exitCode === null) {
    return globalMpvHandle;
  }

  console.log("[player] 🔥 Starting MPV engine");

  globalMpvHandle = await startMpv("");

  globalMpvHandle.proc.once("exit", () => {
    console.warn("[player] MPV exited");
    globalMpvHandle = null;

    if (playing) {
      resetNowState();
    }
  });

  return globalMpvHandle;
}

/* ------------------- CORE PLAY ------------------- */

async function attachListener(
  handle: MpvHandle,
  item: QueueItem,
  onStateChange: () => void
): Promise<void> {
  const attemptId = item.id;

  if (currentListener) {
    handle.removeListener(currentListener);
    currentListener = null;
  }

  currentListener = (ev: MpvEvent) => {
    if (!playing || playing.item.id !== attemptId) return;

    if (ev.type === "playback-restart") {
      if (state.now) {
        state.now.isBuffering = false;
        state.now.startedAt = state.control.paused
          ? null
          : Date.now() - ((state.now.positionOffsetSec || 0) * 1000);

        onStateChange();
      }
      return;
    }

    if (ev.type === "end-file") {
      if (ev.reason === "eof") {
        handleEndOfTrack(item, onStateChange);
      } else if (ev.reason === "error") {
        failItemAndContinue(item, onStateChange);
      }
      return;
    }

    if (ev.type !== "property-change") return;

    if (ev.name === "time-pos" && typeof ev.data === "number") {
      const now = state.now;
      if (!now) return;

      now.positionOffsetSec = ev.data;

      if (now.isBuffering) {
        now.isBuffering = false;
      }

      if (!state.control.paused) {
        const theoreticalPos =
          now.startedAt ? (Date.now() - now.startedAt) / 1000 : 0;

        const drift = Math.abs(theoreticalPos - ev.data);

        if (drift > 1 || !now.startedAt) {
          now.startedAt = Date.now() - ev.data * 1000;
        }
      }

      onStateChange();
      return;
    }

    if (ev.name === "duration" && typeof ev.data === "number" && state.now) {
      if (ev.data > 0 && state.now.durationSec !== ev.data) {
        state.now.durationSec = ev.data;
        onStateChange();
      }
      return;
    }

    if (ev.name === "idle-active" && ev.data === true) {
      const hasStarted = (state.now?.positionOffsetSec || 0) > 0;

      if (playing?.item.id === attemptId && hasStarted) {
        handleEndOfTrack(item, onStateChange);
      }
    }
  };

  handle.on(currentListener);
}

async function tryPlayWith(
  source: PlayableSource,
  item: QueueItem,
  onStateChange: () => void
): Promise<boolean> {
  try {
    const handle = await ensureMpvRunning();

    setPlaying({ item, handle });

    state.now = {
      url: item.url,
      title: item.title,
      thumb: item.thumb,
      addedBy: item.addedBy,
      group: item.group,
      durationSec: item.durationSec || 0,
      isBuffering: true,
      positionOffsetSec: 0,
      startedAt: null,
      clientRequestId: item.clientRequestId,
    };

    onStateChange();

    await attachListener(handle, item, onStateChange);

    await mpvSetAudioProfile(handle, state.control.audioProfile);
    await mpvSetHttpHeaders(handle, source.headers);
    await mpvLoadFile(handle, source.url, false);
    await mpvSetLoopFile(handle, state.control.repeat);
    await mpvPause(handle, state.control.paused);
    await handle.waitForPlaybackStart(MPV_CONFIG.globalStartTimeoutMs);

    return true;
  } catch (err) {
    console.error("[player] play error", err);
    return false;
  }
}

/* ------------------- RESOLUTION ------------------- */

async function resolveSpotifyItem(item: QueueItem): Promise<boolean> {
  if (!item.url.startsWith("provider:spotify:")) return true;

  try {
    const query = item.url.replace("provider:spotify:", "").trim();

    const results = await play.search(query, {
      limit: 1,
      source: { youtube: "video" },
    });

    if (!results.length || !results[0]?.url) {
      throw new Error("No YouTube result found");
    }

    item.url = results[0].url;
    item.title = item.title || results[0].title || query;
    item.thumb = item.thumb || results[0].thumbnails?.[0]?.url || null;

    return true;
  } catch (err) {
    console.error("[player] spotify resolve failed", err);
    return false;
  }
}

async function resolvePlaybackSource(
  item: QueueItem
): Promise<PlayableSource | null> {
  const preloadedSource = await consumePreloaded(item);
  if (preloadedSource) {
    console.log("[player] ⚡ Using preloaded audio");
    return preloadedSource;
  }

  const normalized = normalizeUrl(item.url);

  try {
    const resolved = await resolvePlayable(
      normalized,
      state.control.audioProfile
    );
    if (resolved) return resolved;
  } catch (err) {
    console.warn("[player] resolvePlayable failed, trying fallback", err);
  }

  try {
    const fallback = await getPlayableSource(
      normalized,
      state.control.audioProfile
    );
    if (fallback) return fallback;
  } catch (err) {
    console.warn("[player] getDirectPlayableUrl failed", err);
  }

  return null;
}

/* ------------------- END TRACK ------------------- */

function handleEndOfTrack(item: QueueItem, onStateChange: () => void): void {
  if (item.status !== "playing") return;

  if (state.control.repeat) {
    if (state.now) {
      state.now.positionOffsetSec = 0;
      state.now.startedAt = Date.now();
    }
    return;
  }

  console.log("[player] ✅ Track finished");

  item.status = "done";
  clearPreloadForItem(item.id);
  pushToHistory(item);
  resetNowState();

  onStateChange();

  setTimeout(() => {
    void ensurePlayerLoop(onStateChange);
  }, 0);
}

function failItemAndContinue(item: QueueItem, onStateChange: () => void): void {
  item.status = "error";
  clearPreloadForItem(item.id);
  resetNowState();
  onStateChange();

  setTimeout(() => {
    void ensurePlayerLoop(onStateChange);
  }, 100);
}

/* ------------------- QUEUE LOOP ------------------- */

function pickNextQueuedItem(): QueueItem | null {
  const queued = state.queue.filter((q) => q.status === "queued");
  if (!queued.length) return null;

  if (state.control.randomMode) {
    const ready = queued.filter((item) =>
      isPreloadedForCurrentProfile(item.id)
    );
    const pool = ready.length ? ready : queued;
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  }

  return queued[0] ?? null;
}

export async function ensurePlayerLoop(onStateChange: () => void): Promise<void> {
  if (isLooping) return;
  if (playing && playing.item.status === "playing") return;

  isLooping = true;

  try {
    const nextItem = pickNextQueuedItem();

    if (!nextItem) {
      resetNowState();
      onStateChange();
      return;
    }

    console.log("[player] 🎵 Starting", nextItem.title || nextItem.url);

    const spotifyOk = await resolveSpotifyItem(nextItem);
    if (!spotifyOk) {
      failItemAndContinue(nextItem, onStateChange);
      return;
    }

    nextItem.status = "playing";
    schedulePreloadWorker();

    const source = await resolvePlaybackSource(nextItem);

    if (!source) {
      console.error("[player] unable to resolve playable URL");
      failItemAndContinue(nextItem, onStateChange);
      return;
    }

    const success = await tryPlayWith(source, nextItem, onStateChange);

    if (!success) {
      failItemAndContinue(nextItem, onStateChange);
      return;
    }
  } catch (err) {
    console.error("[player] loop error", err);
  } finally {
    isLooping = false;
  }
}

/* ------------------- ACTIONS ------------------- */

export async function skip(onStateChange: () => void): Promise<void> {
  if (!playing) {
    void ensurePlayerLoop(onStateChange);
    return;
  }

  console.log("[player] ⏭ skip");

  const h = playing.handle;
  const currentItem = playing.item;

  currentItem.status = "done";
  clearPreloadForItem(currentItem.id);
  pushToHistory(currentItem);
  resetNowState();

  onStateChange();

  try {
    await mpvStop(h);
  } catch {}

  void ensurePlayerLoop(onStateChange);
}

export async function seekRelative(
  deltaSec: number,
  onStateChange: () => void
): Promise<void> {
  const h = playing?.handle;
  if (!h || !state.now) return;

  const current = computeCurrentPosition();
  const target = Math.max(0, current + deltaSec);

  state.now.positionOffsetSec = target;
  state.now.startedAt = null;
  state.now.isBuffering = true;

  onStateChange();
  await mpvSeekAbsolute(h, target);
}

export async function playPrevious(onStateChange: () => void): Promise<void> {
  if (state.now && computeCurrentPosition() > 5 && playing?.handle) {
    state.now.positionOffsetSec = 0;
    state.now.startedAt = state.control.paused ? null : Date.now();
    state.now.isBuffering = true;

    onStateChange();
    await mpvSeekAbsolute(playing.handle, 0);
    return;
  }

  const previous = state.history[0];
  if (!previous) return;

  state.history = state.history.slice(1);

  const previousClone: QueueItem = {
    ...previous,
    id: String(nextId.current++),
    createdAt: Date.now(),
    status: "queued",
  };

  const currentItem = playing?.item ?? null;
  const doneOrError = state.queue.filter(
    (q) => q.status !== "queued" && q.status !== "playing"
  );
  const queued = state.queue.filter(
    (q) => q.status === "queued" && q.id !== currentItem?.id
  );

  if (currentItem) {
    currentItem.status = "queued";
  }

  state.queue = [
    ...doneOrError,
    previousClone,
    ...(currentItem ? [currentItem] : []),
    ...queued,
  ];

  resetNowState();
  onStateChange();

  try {
    if (playing?.handle) {
      await mpvStop(playing.handle);
    }
  } catch {}

  void ensurePlayerLoop(onStateChange);
}

export async function skipGroup(onStateChange: () => void): Promise<void> {
  const currentGroup = playing?.item?.group;
  if (!currentGroup) {
    await skip(onStateChange);
    return;
  }

  for (const item of state.queue) {
    if (item.status === "queued" && item.group === currentGroup) {
      item.status = "done";
    }
  }

  await skip(onStateChange);
}

export async function stopPlayer(onStateChange: () => void): Promise<void> {
  if (globalMpvHandle) {
    try {
      globalMpvHandle.kill();
    } catch {}
    globalMpvHandle = null;
  }

  preloaded.clear();
  preloading.clear();

  if (currentListener && playing?.handle) {
    try {
      playing.handle.removeListener(currentListener);
    } catch {}
    currentListener = null;
  }

  resetNowState();
  onStateChange();
}
