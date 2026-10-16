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
  buildSoundCloudYoutubeQuery,
  getPlayableSource,
  normalizeUrl,
  probeSingle,
  searchYoutubeVideo,
  invalidatePlayableSource,
  type PlayableSource,
} from "./ytdlp.js";
import { MPV_CONFIG, PLAYER_CONFIG } from "./config.js";
import { ensureAudioRoutingReady, isVirtualAudioRoutingReady } from "./utils.js";
import type { AudioProfileName } from "./audioProfiles.js";
import { isSoundCloudUrl } from "./platforms/index.js";
import { performance } from "node:perf_hooks";
import { recordBackendMetric } from "./metrics.js";
import {
  deleteProviderMatch,
  getProviderMatch,
  setProviderMatch,
  type ProviderMatch,
} from "./providerCache.js";

let globalMpvHandle: MpvHandle | null = null;
let mpvStartTask: Promise<MpvHandle> | null = null;
let engineGeneration = 0;
let playerLoopTask: Promise<void> | null = null;
let loopRequested = false;
let playbackGeneration = 0;
let playbackSeekSequence = 0;
let activeItem: QueueItem | null = null;
let activeAbortController: AbortController | null = null;
let preferredNextItem: QueueItem | null = null;
let startingPlayback = false;
let currentListener: ((ev: MpvEvent) => void) | null = null;
let listenerHandle: MpvHandle | null = null;
let progressTimer: ReturnType<typeof setInterval> | null = null;
const playbackRetries = new Map<string, number>();
const attemptedSources = new Map<string, { source: PlayableSource; pageUrl: string }>();
const MAX_PLAYBACK_RETRIES = 1;
const PLAYBACK_STALL_TIMEOUT_MS = 60_000;
const PLAYBACK_RECOVERY_PROGRESS_SEC = 30;

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

function normalizeProviderMatchText(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function spotifyMatchCacheKey(query: string, durationSec?: number | null): string {
  return ["spotify", normalizeProviderMatchText(query), Math.round(durationSec || 0)].join("|");
}

function soundCloudFallbackCacheKey(url: string): string {
  return `soundcloud-fallback|${url}`;
}

function applyProviderMatch(item: QueueItem, match: ProviderMatch): void {
  item.sourceUrl ??= item.url;
  item.url = match.url;
  item.title ||= match.title;
  item.thumb ||= match.thumb || null;
  item.durationSec ||= match.durationSec || 0;
}

function recordProviderMatchCache(provider: "spotify" | "soundcloud", hit: boolean, startedAt: number): void {
  recordBackendMetric("provider-match-cache", performance.now() - startedAt, true, { provider, hit });
}

function canResolveItem(item: QueueItem, generation: number): boolean {
  return engineGeneration === generation && (item.status === "queued" || item.status === "playing");
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
  const generation = engineGeneration;
  const spotifyOk = await resolveSpotifyItem(item);
  if (!spotifyOk || !canResolveItem(item, generation)) return null;

  if (item.url.startsWith("provider:")) return null;

  return resolveFreshItemSource(item, audioProfile);
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
  let observedSeekSequence = playbackSeekSequence;
  let recoveryProgressSec = 0;
  const recoveryStartedAt = Date.now();

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

    if (ev.name === "time-pos" && typeof ev.data === "number" && Number.isFinite(ev.data)) {
      const now = state.now;
      if (!now) return;
      if (Math.abs(ev.data - lastPosition) > 0.01) {
        const progressedAt = Date.now();
        const delta = ev.data - lastPosition;
        const elapsedSec = Math.max(0, (progressedAt - lastProgressAt) / 1000);
        if (observedSeekSequence !== playbackSeekSequence || delta > 5) {
          recoveryProgressSec = 0;
        } else if (!state.control.paused && delta > 0 && lastPosition >= 0 && playbackRetries.has(item.id)) {
          // Re-arm recovery only after sustained real playback. file-loaded,
          // seeks, a paused clock and bursts of property events prove nothing.
          recoveryProgressSec += Math.min(delta, elapsedSec);
          if (recoveryProgressSec >= PLAYBACK_RECOVERY_PROGRESS_SEC) {
            playbackRetries.delete(item.id);
            recordDiagnostic("PLAYBACK_RECOVERED", {
              trackId: item.id,
              durationMs: progressedAt - recoveryStartedAt,
            });
          }
        }
        observedSeekSequence = playbackSeekSequence;
        lastPosition = ev.data;
        lastProgressAt = progressedAt;
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
  const startedAt = performance.now();
  try {
    const handle = await ensureMpvRunning();
    if (!isCurrentAttempt(item, generation)) return false;

    attemptedSources.set(item.id, { source, pageUrl: item.url });
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
    if (isCurrentAttempt(item, generation)) {
      console.error("[player] play error", err);
      recordDiagnostic("PLAYBACK_START_FAILED", {
        trackId: item.id,
        durationMs: performance.now() - startedAt,
        ...diagnosticErrorDetails(err),
      });
    }
    return false;
  }
}

/* ------------------- RESOLUTION ------------------- */

async function resolveSpotifyItem(item: QueueItem, bypassCache = false): Promise<boolean> {
  const originalUrl = item.sourceUrl || item.url;
  if (!originalUrl.startsWith("provider:spotify:")) return true;
  const generation = engineGeneration;

  try {
    const startedAt = performance.now();
    const query = originalUrl.replace("provider:spotify:", "").trim();
    const cacheKey = spotifyMatchCacheKey(query, item.durationSec);
    const cached = bypassCache ? null : getProviderMatch(cacheKey);
    recordProviderMatchCache("spotify", Boolean(cached), startedAt);
    if (cached) {
      if (!canResolveItem(item, generation)) return false;
      applyProviderMatch(item, cached);
      return true;
    }

    const searchQuery = /\bofficial\s+audio\b/i.test(query) ? query : `${query} official audio`;
    const result = await searchYoutubeVideo(searchQuery, {
      expectedDurationSec: item.durationSec,
      limit: 6,
      bypassCache,
    });
    if (!result?.url || !canResolveItem(item, generation)) return false;

    applyProviderMatch(item, result);
    setProviderMatch(cacheKey, result);
    return true;
  } catch (err) {
    console.error("[player] spotify resolve failed", err);
    return false;
  }
}

type SourceOptions = { bypassCache?: boolean; skipDebugLabels?: string[] };

function sourceOptions(item: QueueItem): SourceOptions {
  if (!playbackRetries.has(item.id)) return {};
  const label = attemptedSources.get(item.id)?.source.debugLabel;
  return { bypassCache: true, skipDebugLabels: label ? [label] : [] };
}

async function extractSource(
  url: string,
  audioProfile: AudioProfileName,
  options: SourceOptions
): Promise<PlayableSource | null> {
  try {
    return await getPlayableSource(url, audioProfile, options);
  } catch (err) {
    console.warn("[player] playable source resolution failed", err);
    return null;
  }
}

async function resolveFreshItemSource(
  item: QueueItem,
  audioProfile: AudioProfileName
): Promise<PlayableSource | null> {
  const generation = engineGeneration;
  const options = sourceOptions(item);
  const originalUrl = item.sourceUrl || item.url;
  if (isSoundCloudUrl(originalUrl)) {
    return resolveSoundCloudSource(item, normalizeUrl(originalUrl), audioProfile, options);
  }

  const source = await extractSource(normalizeUrl(item.url), audioProfile, options);
  if (!canResolveItem(item, generation)) return null;
  if (source) return source;

  // A persisted provider match can outlive a removed/private YouTube video.
  // Recover its original query and rematch instead of retrying that URL forever.
  if (originalUrl.startsWith("provider:spotify:")) {
    const query = originalUrl.replace("provider:spotify:", "").trim();
    deleteProviderMatch(spotifyMatchCacheKey(query, item.durationSec));
    if (!await resolveSpotifyItem(item, true) || !canResolveItem(item, generation)) return null;
    return extractSource(normalizeUrl(item.url), audioProfile, options);
  }
  return null;
}

async function resolvePlaybackSource(item: QueueItem): Promise<PlayableSource | null> {
  if (!playbackRetries.has(item.id)) {
    const preloadedSource = await consumePreloaded(item);
    if (preloadedSource) {
      console.log("[player] ⚡ Using preloaded audio");
      return preloadedSource;
    }
  }
  return resolveFreshItemSource(item, state.control.audioProfile);
}

async function resolveSoundCloudSource(
  item: QueueItem,
  originalUrl: string,
  audioProfile: AudioProfileName,
  options: SourceOptions
): Promise<PlayableSource | null> {
  const generation = engineGeneration;
  const startedAt = performance.now();
  const cacheKey = soundCloudFallbackCacheKey(originalUrl);
  const cached = getProviderMatch(cacheKey);
  recordProviderMatchCache("soundcloud", Boolean(cached), startedAt);

  // Reuse learned matches, but retain the SoundCloud identity until a playable
  // source is confirmed. A rejected match must still allow direct SC playback.
  if (cached) {
    const source = await extractSource(cached.url, audioProfile, options);
    if (!canResolveItem(item, generation)) return null;
    if (source) {
      applyProviderMatch(item, cached);
      return source;
    }
    deleteProviderMatch(cacheKey);
  }

  const direct = await extractSource(originalUrl, audioProfile, options);
  if (!canResolveItem(item, generation)) return null;
  if (direct) {
    if (item.sourceUrl) item.url = originalUrl;
    return direct;
  }

  return resolveSoundCloudFallbackSource(item, originalUrl, audioProfile, options, Boolean(cached));
}

async function resolveSoundCloudFallbackSource(
  item: QueueItem,
  originalUrl: string,
  audioProfile: AudioProfileName,
  options: SourceOptions,
  bypassSearchCache: boolean
): Promise<PlayableSource | null> {
  const generation = engineGeneration;
  try {
    const metadata = await probeSingle(originalUrl);
    if (!canResolveItem(item, generation)) return null;
    const title = metadata.title?.trim();
    const query = buildSoundCloudYoutubeQuery(title, originalUrl);
    if (!query || query.toLowerCase() === "soundcloud") return null;

    console.warn(`[player] SoundCloud fallback: searching YouTube for "${query}"`);
    const found = await searchYoutubeVideo(query, {
      expectedDurationSec: metadata.durationSec || item.durationSec,
      limit: 8,
      bypassCache: bypassSearchCache,
    });
    if (!found?.url || !canResolveItem(item, generation)) return null;
    const source = await extractSource(found.url, audioProfile, options);
    if (!source || !canResolveItem(item, generation)) return null;

    const match: ProviderMatch = {
      url: found.url,
      title: title && title.toLowerCase() !== "soundcloud" ? title : found.title,
      thumb: metadata.thumb || found.thumb || item.thumb,
      durationSec: metadata.durationSec || found.durationSec || item.durationSec,
    };
    applyProviderMatch(item, match);
    setProviderMatch(soundCloudFallbackCacheKey(originalUrl), match);
    return source;
  } catch (err) {
    console.warn("[player] SoundCloud fallback failed", err);
    return null;
  }
}

/* ------------------- END TRACK ------------------- */

function handleEndOfTrack(item: QueueItem, onStateChange: () => void): void {
  if (item.status !== "playing") return;

  if (state.control.repeat) {
    // Completing the file proves recovery too, including short repeated clips.
    playbackRetries.delete(item.id);
    attemptedSources.delete(item.id);
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
  attemptedSources.delete(item.id);
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
    invalidatePlayableSource(attemptedSources.get(item.id)?.pageUrl || item.url, state.control.audioProfile);
    item.status = "queued";
    preferredNextItem = item;
    console.warn(`[player] Nouvelle tentative avec une source fraîche : ${item.title || item.id}`);
    recordDiagnostic("PLAYBACK_RETRY", { trackId: item.id, attempt: retries + 1 });
  } else {
    item.status = "error";
    playbackRetries.delete(item.id);
    attemptedSources.delete(item.id);
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
  attemptedSources.delete(currentItem.id);
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
    ++playbackSeekSequence;
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
  if (currentItem) {
    playbackRetries.delete(currentItem.id);
    attemptedSources.delete(currentItem.id);
  }

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
  attemptedSources.clear();
  preferredNextItem = null;
  if (activeItem?.status === "playing") activeItem.status = "done";
  resetNowState();
  onStateChange();
}
