import {
  state,
  playing,
  setPlaying,
  QueueItem,
  MpvHandle,
  MpvEvent,
} from "./types.js";
import { queueService } from "./queue.js";
import { playbackPosition, playbackClockAt, clampPlaybackPosition } from "../../shared/playback.js";
import { recordDiagnostic, diagnosticErrorDetails } from "./diagnostics.js";
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
  searchYoutubeVideo,
  invalidatePlayableSource,
  type PlayableSource,
} from "./ytdlp.js";
import { MPV_CONFIG, PLAYER_CONFIG } from "./config.js";
import { ensureAudioRoutingReady, isVirtualAudioRoutingReady } from "./utils.js";
import type { AudioProfileName } from "./audioProfiles.js";

let globalMpvHandle: MpvHandle | null = null;
let mpvStartTask: Promise<MpvHandle> | null = null;
let engineGeneration = 0;
let playerLoopTask: Promise<void> | null = null;
let loopRequested = false;
let playbackGeneration = 0;
let activeItem: QueueItem | null = null;
let activeAbortController: AbortController | null = null;
let preferredNextItem: QueueItem | null = null;
let startingPlayback = false;
let currentListener: ((ev: MpvEvent) => void) | null = null;
let listenerHandle: MpvHandle | null = null;
let progressTimer: ReturnType<typeof setInterval> | null = null;
const playbackRetries = new Map<string, number>();
const MAX_PLAYBACK_RETRIES = 1;
const PLAYBACK_STALL_TIMEOUT_MS = 60_000;

export function getPlayerDiagnostics() {
  const handle = globalMpvHandle;
  const item = activeItem || preferredNextItem;
  const retryCount = item ? playbackRetries.get(item.id) ?? 0 : 0;
  return {
    engineRunning: Boolean(handle && handle.proc.exitCode === null &&
      handle.proc.signalCode === null && !handle.proc.killed &&
      handle.sock && !handle.sock.destroyed),
    engineStarting: mpvStartTask !== null,
    loopRunning: playerLoopTask !== null,
    startingPlayback,
    buffering: Boolean(state.now?.isBuffering),
    recovering: retryCount > 0 && (startingPlayback || !playing),
    retryCount,
    currentItem: item ? { id: item.id, status: item.status } : null,
    preloaded: preloaded.size,
    preloading: preloading.size,
  };
}

function detachPlaybackListener(): void {
  if (currentListener && listenerHandle) listenerHandle.removeListener(currentListener);
  currentListener = null;
  listenerHandle = null;
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}

function isCurrentAttempt(item: QueueItem, generation: number): boolean {
  return playbackGeneration === generation && activeItem === item && item.status === "playing";
}

function cancelActiveAttempt(): void {
  ++playbackGeneration;
  activeAbortController?.abort();
  activeAbortController = null;
}

function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new Error("Lecture annulée"));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

/* ------------------- PRELOAD SYSTEM ------------------- */

type PreloadedSource = {
  audioProfile: AudioProfileName;
  source: PlayableSource;
};

type PreloadingSource = {
  audioProfile: AudioProfileName;
  task: Promise<PlayableSource | null>;
  token: symbol;
};

let preloaded = new Map<string, PreloadedSource>();
let preloading = new Map<string, PreloadingSource>();
let preloadWorkerRunning = false;

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
  const cached = preloaded.get(itemId);
  return cached?.audioProfile === state.control.audioProfile && isFreshSource(cached.source);
}

function isFreshSource(source: PlayableSource): boolean {
  return !source.expiresAt || source.expiresAt > Date.now() + 15_000;
}

async function resolveItemToSource(
  item: QueueItem,
  audioProfile: AudioProfileName
): Promise<PlayableSource | null> {
  const spotifyOk = await resolveSpotifyItem(item);
  if (!spotifyOk) return null;

  if (item.url.startsWith("provider:")) return null;

  return getPlayableSource(normalizeUrl(item.url), audioProfile);
}

async function preloadTrack(item: QueueItem): Promise<PlayableSource | null> {
  if (!item) return null;
  const ready = preloaded.get(item.id);
  if (ready?.audioProfile === state.control.audioProfile && isFreshSource(ready.source)) return ready.source;
  if (ready) preloaded.delete(item.id);
  const pending = preloading.get(item.id);
  if (pending?.audioProfile === state.control.audioProfile) {
    return pending.task;
  }
  if (pending) return null;
  if (item.status !== "queued") return null;

  const audioProfile = state.control.audioProfile;
  const token = Symbol(item.id);
  const task: Promise<PlayableSource | null> = (async () => {
    try {
      const source = await resolveItemToSource(item, audioProfile);

      if (source && item.status === "queued" && preloading.get(item.id)?.token === token) {
        preloaded.set(item.id, { audioProfile, source });
        trimPreloadCache();
        console.log(`[player] ⚡ Préchargé: ${item.title || item.url}`);
      }

      return source;
    } catch (err) {
      console.warn("[player] preload failed", err);
      return null;
    } finally {
      if (preloading.get(item.id)?.token === token) preloading.delete(item.id);
    }
  })();

  preloading.set(item.id, { audioProfile, task, token });
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
  if (ready?.audioProfile === state.control.audioProfile && isFreshSource(ready.source)) {
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
  return pending.audioProfile === state.control.audioProfile && out && isFreshSource(out) ? out : null;
}

function clearPreloadForItem(itemId: string): void {
  preloaded.delete(itemId);
  preloading.delete(itemId);
}

function resetNowState(): void {
  detachPlaybackListener();
  activeItem = null;
  state.now = null;
  setPlaying(null);
}

/* ------------------- MPV ------------------- */

export async function ensureMpvRunning(): Promise<MpvHandle> {
  if (globalMpvHandle && globalMpvHandle.proc.exitCode === null &&
      globalMpvHandle.proc.signalCode === null && !globalMpvHandle.proc.killed &&
      globalMpvHandle.sock && !globalMpvHandle.sock.destroyed) {
    return globalMpvHandle;
  }
  if (mpvStartTask) return mpvStartTask;

  console.log("[player] 🔥 Starting MPV engine");
  const generation = engineGeneration;
  const task = (async () => {
    await ensureAudioRoutingReady();
    if (!isVirtualAudioRoutingReady()) {
      throw new Error("Le routage audio virtuel n'est pas prêt : lecture bloquée.");
    }
    if (generation !== engineGeneration) throw new Error("Démarrage MPV annulé");
    const handle = await startMpv("");
    if (generation !== engineGeneration) {
      handle.kill();
      throw new Error("Démarrage MPV annulé");
    }
    globalMpvHandle = handle;
    recordDiagnostic("MPV_STARTED");
    handle.proc.once("exit", (code) => {
      if (globalMpvHandle !== handle) return;
      console.warn("[player] MPV exited");
      recordDiagnostic("MPV_EXITED", { exitCode: code ?? undefined });
      globalMpvHandle = null;
      const item = playing?.handle === handle ? playing.item : null;
      const notify = playbackStateChange;
      if (item && notify && !startingPlayback) recoverPlayback(item, notify);
    });
    return handle;
  })();
  mpvStartTask = task;
  try { return await task; }
  finally { if (mpvStartTask === task) mpvStartTask = null; }
}

let playbackStateChange: (() => void) | null = null;

/* ------------------- CORE PLAY ------------------- */

function attachListener(
  handle: MpvHandle,
  item: QueueItem,
  onStateChange: () => void,
  generation: number
): void {
  detachPlaybackListener();
  let lastProgressAt = Date.now();
  let lastPosition = -1;

  currentListener = (ev: MpvEvent) => {
    if (!isCurrentAttempt(item, generation) || playing?.handle !== handle) return;

    if (ev.type === "playback-restart") {
      lastProgressAt = Date.now();
      if (state.now) {
        state.now.isBuffering = false;
        Object.assign(state.now, playbackClockAt(state.now.positionOffsetSec ?? 0, state.control.paused));

        onStateChange();
      }
      return;
    }

    if (ev.type === "end-file") {
      if (ev.reason === "eof") {
        handleEndOfTrack(item, onStateChange);
      } else if (!startingPlayback && (ev.reason === "error" || ev.reason === "stop")) {
        recoverPlayback(item, onStateChange);
      }
      return;
    }

    if (ev.type !== "property-change") return;

    if (ev.name === "time-pos" && typeof ev.data === "number") {
      const now = state.now;
      if (!now) return;
      if (Math.abs(ev.data - lastPosition) > 0.01) {
        lastPosition = ev.data;
        lastProgressAt = Date.now();
      }

      const wasBuffering = Boolean(now.isBuffering);
      let clientClockChanged = wasBuffering;
      now.positionOffsetSec = ev.data;

      if (wasBuffering) {
        now.isBuffering = false;
      }

      if (!state.control.paused) {
        const theoreticalPos = playbackPosition(now, false, Date.now(), false);

        const drift = Math.abs(theoreticalPos - ev.data);

        if (drift > 1 || now.startedAt == null || !Number.isFinite(now.startedAt)) {
          Object.assign(now, playbackClockAt(ev.data));
          clientClockChanged = true;
        }
      }

      // MPV can report time-pos many times per second. The clients derive the
      // smooth position locally from startedAt. Only send the complete state
      // when buffering ends or that shared clock actually needs correction.
      if (clientClockChanged) onStateChange();
      return;
    }

    if (ev.name === "duration" && typeof ev.data === "number" && state.now) {
      if (ev.data > 0 && state.now.durationSec !== ev.data) {
        state.now.durationSec = ev.data;
        onStateChange();
      }
      return;
    }

    if (ev.name === "paused-for-cache" && typeof ev.data === "boolean" && state.now) {
      if (state.now.isBuffering === ev.data) return;
      const position = playbackPosition(state.now, state.control.paused);
      state.now.isBuffering = ev.data;
      Object.assign(state.now, playbackClockAt(position, ev.data || state.control.paused));
      onStateChange();
    }
  };

  listenerHandle = handle;
  handle.on(currentListener);
  progressTimer = setInterval(() => {
    if (!isCurrentAttempt(item, generation)) return;
    if (state.control.paused || startingPlayback) {
      lastProgressAt = Date.now();
      return;
    }
    if (Date.now() - lastProgressAt > PLAYBACK_STALL_TIMEOUT_MS) {
      console.warn(`[player] Lecture bloquée depuis 60 s : ${item.title || item.id}`);
      recordDiagnostic("PLAYBACK_STALLED", { trackId: item.id });
      // Destroy the stuck engine; a retry must use a fresh transport and URL.
      if (globalMpvHandle === handle) globalMpvHandle = null;
      recoverPlayback(item, onStateChange);
      handle.kill();
    }
  }, 5_000);
  progressTimer.unref();
}

async function tryPlayWith(
  source: PlayableSource,
  item: QueueItem,
  onStateChange: () => void,
  generation: number
): Promise<boolean> {
  try {
    const handle = await ensureMpvRunning();
    if (!isCurrentAttempt(item, generation)) return false;

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

    await mpvSetAudioProfile(handle, state.control.audioProfile);
    if (!isCurrentAttempt(item, generation)) return false;
    await mpvSetHttpHeaders(handle, source.headers);
    if (!isCurrentAttempt(item, generation)) return false;
    attachListener(handle, item, onStateChange, generation);
    await mpvLoadFile(handle, source.url, false);
    if (!isCurrentAttempt(item, generation)) return false;
    await mpvSetLoopFile(handle, state.control.repeat);
    if (!isCurrentAttempt(item, generation)) return false;
    await mpvPause(handle, state.control.paused);
    await handle.waitForPlaybackStart(MPV_CONFIG.globalStartTimeoutMs);

    const started = isCurrentAttempt(item, generation);
    if (started) recordDiagnostic("PLAYBACK_STARTED", { trackId: item.id });
    return started;
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

    const result = await searchYoutubeVideo(query);

    if (!result?.url) {
      throw new Error("No YouTube result found");
    }

    item.url = result.url;
    item.title = item.title || result.title || query;
    item.thumb = item.thumb || result.thumb || null;
    item.durationSec = item.durationSec || result.durationSec || 0;

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
    item.status = "queued";
    preferredNextItem = item;
    cancelActiveAttempt();
    resetNowState();
    onStateChange();
    void ensurePlayerLoop(onStateChange);
    return;
  }

  console.log("[player] ✅ Track finished");

  item.status = "done";
  playbackRetries.delete(item.id);
  cancelActiveAttempt();
  clearPreloadForItem(item.id);
  queueService.addToHistory(item);
  resetNowState();

  onStateChange();

  void ensurePlayerLoop(onStateChange);
}

function recoverPlayback(item: QueueItem, onStateChange: () => void): void {
  if (item.status !== "playing") return;
  const retries = playbackRetries.get(item.id) || 0;
  if (retries < MAX_PLAYBACK_RETRIES) {
    playbackRetries.set(item.id, retries + 1);
    invalidatePlayableSource(item.url, state.control.audioProfile);
    item.status = "queued";
    preferredNextItem = item;
    console.warn(`[player] Nouvelle tentative avec une source fraîche : ${item.title || item.id}`);
    recordDiagnostic("PLAYBACK_RETRY", { trackId: item.id, attempt: retries + 1 });
  } else {
    item.status = "error";
    playbackRetries.delete(item.id);
    console.error(`[player] Piste abandonnée après deux échecs : ${item.title || item.id}`);
    recordDiagnostic("PLAYBACK_ABANDONED", { trackId: item.id, attempt: retries + 1 });
  }
  cancelActiveAttempt();
  clearPreloadForItem(item.id);
  resetNowState();
  onStateChange();
  void ensurePlayerLoop(onStateChange);
}

/* ------------------- QUEUE LOOP ------------------- */

function pickNextQueuedItem(): QueueItem | null {
  if (preferredNextItem) {
    const preferred = preferredNextItem;
    preferredNextItem = null;
    if (preferred.status === "queued" && state.queue.includes(preferred)) return preferred;
  }
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
  playbackStateChange = onStateChange;
  loopRequested = true;
  if (playerLoopTask) return playerLoopTask;

  const runGeneration = engineGeneration;
  const task = (async () => {
    do {
      loopRequested = false;
      if (runGeneration !== engineGeneration) break;
      if (playing?.item.status === "playing") break;
      const nextItem = pickNextQueuedItem();
      if (!nextItem) {
        resetNowState();
        onStateChange();
        break;
      }

      console.log("[player] 🎵 Starting", nextItem.title || nextItem.url);
      nextItem.status = "playing";
      activeItem = nextItem;
      const generation = ++playbackGeneration;
      const controller = new AbortController();
      activeAbortController = controller;
      startingPlayback = true;
      try {
        const spotifyOk = await cancellable(resolveSpotifyItem(nextItem), controller.signal);
        if (!isCurrentAttempt(nextItem, generation)) throw new Error("Lecture annulée");
        if (!spotifyOk) throw new Error("Résolution Spotify impossible");
        schedulePreloadWorker();
        const source = await cancellable(resolvePlaybackSource(nextItem), controller.signal);
        if (!isCurrentAttempt(nextItem, generation)) throw new Error("Lecture annulée");
        if (!source) throw new Error("URL de lecture introuvable");
        const success = await cancellable(tryPlayWith(source, nextItem, onStateChange, generation), controller.signal);
        if (!success && isCurrentAttempt(nextItem, generation)) throw new Error("Échec du démarrage MPV");
      } catch (error) {
        if (isCurrentAttempt(nextItem, generation)) {
          console.error("[player] loop error", error);
          recordDiagnostic("PLAYBACK_RESOLUTION_FAILED", { trackId: nextItem.id, ...diagnosticErrorDetails(error) });
          // A timed-out load may still be active inside MPV. End it before
          // starting the replacement, with the old listener already detached.
          detachPlaybackListener();
          const handle = playing?.handle;
          if (handle) {
            try { await mpvStop(handle); } catch {}
          }
          if (isCurrentAttempt(nextItem, generation)) recoverPlayback(nextItem, onStateChange);
        }
      } finally {
        startingPlayback = false;
      }
      if (runGeneration === engineGeneration && !playing &&
          state.queue.some((item) => item.status === "queued")) loopRequested = true;
    } while (loopRequested);
  })();
  playerLoopTask = task;
  try { await task; }
  finally {
    if (playerLoopTask === task) playerLoopTask = null;
    if (loopRequested && !playing) void ensurePlayerLoop(onStateChange);
  }
}

/* ------------------- ACTIONS ------------------- */

export async function skip(onStateChange: () => void): Promise<void> {
  const currentItem = playing?.item || activeItem;
  if (!currentItem) {
    void ensurePlayerLoop(onStateChange);
    return;
  }

  console.log("[player] ⏭ skip");

  const h = playing?.handle;

  currentItem.status = "done";
  playbackRetries.delete(currentItem.id);
  cancelActiveAttempt();
  clearPreloadForItem(currentItem.id);
  queueService.addToHistory(currentItem);
  resetNowState();

  onStateChange();

  try {
    if (h) await mpvStop(h);
  } catch {}

  void ensurePlayerLoop(onStateChange);
}

export async function seekRelative(
  deltaSec: number,
  onStateChange: () => void
): Promise<void> {
  await seekAbsolute(playbackPosition(state.now, state.control.paused) + deltaSec, onStateChange);
}

export async function seekAbsolute(
  positionSec: number,
  onStateChange: () => void
): Promise<void> {
  if (!Number.isFinite(positionSec)) throw new Error("Position invalide");
  const h = playing?.handle;
  const now = state.now;
  if (!h || !now) return;
  const generation = playbackGeneration;
  const target = clampPlaybackPosition(positionSec, now.durationSec);
  const snapshot = { positionOffsetSec: now.positionOffsetSec, startedAt: now.startedAt, isBuffering: now.isBuffering };
  now.positionOffsetSec = target;
  now.startedAt = null;
  now.isBuffering = true;

  onStateChange();
  try {
    await mpvSeekAbsolute(h, target);
  } catch (error) {
    if (state.now === now && generation === playbackGeneration &&
        now.isBuffering && now.positionOffsetSec === target) {
      Object.assign(now, snapshot);
      onStateChange();
    }
    throw error;
  }
}

export async function playPrevious(onStateChange: () => void): Promise<void> {
  if (state.now && playbackPosition(state.now, state.control.paused) > 5 && playing?.handle) {
    await seekAbsolute(0, onStateChange);
    return;
  }

  const handle = playing?.handle;
  const currentItem = playing?.item || activeItem;
  const previousClone = queueService.restorePrevious(currentItem);
  if (!previousClone) return;
  if (currentItem) playbackRetries.delete(currentItem.id);

  cancelActiveAttempt();
  preferredNextItem = previousClone;
  resetNowState();
  onStateChange();

  try {
    if (handle) await mpvStop(handle);
  } catch {}

  void ensurePlayerLoop(onStateChange);
}

export async function skipGroup(onStateChange: () => void): Promise<void> {
  const currentGroup = (playing?.item || activeItem)?.group;
  if (!currentGroup) {
    await skip(onStateChange);
    return;
  }

  queueService.finishQueuedGroup(currentGroup);

  await skip(onStateChange);
}

export async function stopPlayer(onStateChange: () => void): Promise<void> {
  cancelActiveAttempt();
  ++engineGeneration;
  loopRequested = false;
  mpvStartTask = null;
  const handle = globalMpvHandle;
  globalMpvHandle = null;
  if (handle) {
    try {
      handle.kill();
    } catch {}
  }

  preloaded.clear();
  preloading.clear();
  playbackRetries.clear();
  preferredNextItem = null;
  if (activeItem?.status === "playing") activeItem.status = "done";
  resetNowState();
  onStateChange();
}
