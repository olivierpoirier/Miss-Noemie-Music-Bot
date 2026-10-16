process.env.PLAY_DL_SKIP_PROMPT = "true";

import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import { Server as IOServer } from "socket.io";
import { fileURLToPath } from "node:url";
import { playbackPosition } from "../../shared/playback.js";
import type { DiagnosticSnapshot } from "../../shared/contracts.js";

import { APP_CONFIG, MPV_CONFIG, SECURITY_CONFIG } from "./config.js";
import { normalizeAudioProfileName } from "./audioProfiles.js";
import { state, playing } from "./types.js";
import { queueService } from "./queue.js";
import { getMetrics } from "./metrics.js";
import { flushProviderMatchCache } from "./providerCache.js";
import { diagnostics, recordDiagnostic, diagnosticErrorDetails } from "./diagnostics.js";
import { checkToolDiagnostics } from "./toolDiagnostics.js";
import {
  ensurePlayerLoop,
  ensureMpvRunning,
  skip,
  stopPlayer,
  seekRelative,
  seekAbsolute,
  playPrevious,
  skipGroup,
  warmUpcomingTracks,
  getPlayerDiagnostics,
} from "./player.js";
import {
  mpvPause,
  mpvSetLoopFile,
  mpvSetAudioProfile,
} from "./mpv.js";
import {
  resolveUrlToPlayableItems,
  probeSingle,
  normalizeUrl,
  searchYoutubeVideo,
} from "./ytdlp.js";
import {
  isPlaylistUrl,
  isSoundCloudUrl,
  isSpotifyUrl,
  isYoutubeSearchUrl,
} from "./platforms/index.js";
import {
  ensureAudioRoutingReady,
  getRuntimeAudioRouting,
  isVirtualAudioRoutingReady,
} from "./utils.js";

const app = express();
const server = http.createServer(app);

function isOriginAllowed(origin?: string): boolean {
  if (!origin || SECURITY_CONFIG.allowedOrigins.length === 0) return true;
  return SECURITY_CONFIG.allowedOrigins.some((pattern) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i").test(origin);
  });
}

const corsOptions = {
  origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
    callback(null, isOriginAllowed(origin));
  },
};
app.use(cors(corsOptions));
const io = new IOServer(server, {
  cors: corsOptions,
  maxHttpBufferSize: SECURITY_CONFIG.maxSocketPayloadBytes,
  perMessageDeflate: false,
});
io.use((socket, next) => {
  if (isOriginAllowed(socket.handshake.headers.origin)) next();
  else next(new Error("Origine non autorisée."));
});

/* --- VARIABLES DE CONTRÔLE DU CYCLE DE VIE --- */

let systemAudioWarning: string | null = null;
let activeUsers = 0;
let shutdownTimer: NodeJS.Timeout | null = null;
let queueRevision = 0;
let controlTask = Promise.resolve();

app.use(express.static(fileURLToPath(new URL("../../frontend/dist/", import.meta.url))));

/* --- HELPERS --- */

function computePosition(now: typeof state.now): number {
  return playbackPosition(now, state.control.paused);
}

function isProbablyUrl(input: string): boolean {
  return /^https?:\/\//i.test(input) || input.startsWith("spotify:");
}

function broadcast(): void {
  io.emit("state", {
    ok: true,
    now: state.now,
    ...queueService.snapshot(),
    control: state.control,
  });
}

async function enrichQueuedItem(entryId: string, url: string): Promise<void> {
  try {
    const enriched = await probeSingle(url);
    const item = state.queue.find((q) => q.id === entryId);

    if (!item) return;
    if (item.status === "done" || item.status === "error") return;

    item.title = enriched.title;
    item.thumb = enriched.thumb ?? null;
    item.durationSec = enriched.durationSec;

    if (state.now && state.now.url === item.url) {
      state.now.title = enriched.title;
      state.now.thumb = enriched.thumb ?? null;
      state.now.durationSec = enriched.durationSec;
    }

    broadcast();
  } catch (err) {
    console.warn("[probeSingle] failed", err);
  }
}

async function resolveSearchTextToVideoUrl(query: string): Promise<{
  url: string;
  title?: string;
  thumb?: string | null;
  durationSec?: number;
} | null> {
  try {
    return await searchYoutubeVideo(query);
  } catch (err) {
    console.error("[search text resolve failed]", err);
    return null;
  }
}

function warmQueueIfPlaying(): void {
  if (playing) {
    warmUpcomingTracks();
  }
}

function finishQueueAdd(acknowledge?: () => void, beforeStart?: () => void): void {
  broadcast();
  acknowledge?.();
  warmQueueIfPlaying();
  beforeStart?.();
  void ensurePlayerLoop(broadcast).catch(console.error);
}

async function refreshAudioRouting(): Promise<boolean> {
  const ready = await ensureAudioRoutingReady();
  const routing = getRuntimeAudioRouting();
  systemAudioWarning = ready && isVirtualAudioRoutingReady()
    ? null
    : routing.message || "Le routage audio virtuel n'est pas prêt. La lecture est bloquée.";
  recordDiagnostic(systemAudioWarning ? "AUDIO_ROUTING_UNAVAILABLE" : "AUDIO_ROUTING_READY");
  io.emit("error_system", systemAudioWarning);
  return systemAudioWarning === null;
}

/* --- ROUTES HTTP --- */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    activeUsers,
    audioRouting: getRuntimeAudioRouting(),
    playing: Boolean(playing),
    queued: state.queue.filter((item) => item.status === "queued").length,
    idleShutdownMs: APP_CONFIG.idleShutdownMs,
  });
});

app.get("/metrics", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ status: "ok", metrics: getMetrics() });
});

app.get("/diagnostics", (_req, res) => {
  // Return only explicit diagnostic fields. Configuration objects include
  // credentials and must never be serialized, even for a local server.
  void (async () => {
    const tools = await checkToolDiagnostics();
    const player = getPlayerDiagnostics();
    const audio = getRuntimeAudioRouting();
    res.setHeader("Cache-Control", "no-store");
    const snapshot: DiagnosticSnapshot = {
      ok: true,
      timestamp: new Date().toISOString(),
      server: {
        uptimeSec: process.uptime(), activeUsers,
        queued: state.queue.filter((item) => item.status === "queued").length,
        idleShutdownMs: APP_CONFIG.idleShutdownMs,
      },
      player: {
        engineRunning: player.engineRunning,
        starting: player.engineStarting,
        loading: player.startingPlayback,
        buffering: player.buffering,
        paused: state.control.paused,
        retryCount: player.retryCount,
      },
      audioRouting: {
        ready: isVirtualAudioRoutingReady(),
        degraded: audio.degraded,
        message: audio.message,
      },
      tools,
      recentEvents: diagnostics.events(),
      logging: diagnostics.status(),
    };
    res.json(snapshot);
  })().catch((error) => {
    recordDiagnostic("DIAGNOSTICS_REQUEST_FAILED", diagnosticErrorDetails(error));
    if (!res.headersSent) res.status(503).json({ ok: false, message: "Diagnostic temporairement indisponible." });
  });
});

/* --- LOGIQUE SOCKET --- */

io.on("connection", (socket) => {
  let windowStartedAt = Date.now();
  let commandCount = 0;
  let nextRateLimitToastAt = 0;
  const acceptCommand = (event: string, payload: unknown): boolean => {
    const now = Date.now();
    if (now - windowStartedAt >= SECURITY_CONFIG.socketRateLimitWindowMs) {
      windowStartedAt = now;
      commandCount = 0;
    }
    if (++commandCount <= SECURITY_CONFIG.socketRateLimitMax) return true;
    const message = "Trop de commandes. Réessaie dans quelques secondes.";
    if (event === "play") {
      const clientRequestId = payload && typeof payload === "object" &&
        "clientRequestId" in payload && typeof payload.clientRequestId === "string"
        ? payload.clientRequestId.trim().slice(0, 128) || undefined : undefined;
      socket.emit("play_result", { clientRequestId, ok: false, message });
    }
    if (now >= nextRateLimitToastAt) {
      socket.emit("toast", message);
      nextRateLimitToastAt = now + 5_000;
    }
    return false;
  };
  // EventEmitter does not await async callbacks. Contain rejected commands and
  // malformed payloads here rather than letting them terminate the process.
  const on = (
    event: string,
    handler: (payload: any) => void | Promise<void>,
    serialized = false
  ) => {
    socket.on(event, (payload: unknown) => {
      if (!acceptCommand(event, payload)) return;
      const run = async () => {
        try {
          await handler(payload);
        } catch (error) {
          recordDiagnostic("SOCKET_COMMAND_FAILED", diagnosticErrorDetails(error));
          console.error(`[socket:${event}]`, error);
          socket.emit("toast", "La commande a échoué. Réessaie dans un instant.");
          broadcast();
        }
      };
      if (serialized) {
        controlTask = controlTask.then(run);
      } else {
        void run();
      }
    });
  };

  activeUsers++;
  console.log(`👤 Client connecté. Total: ${activeUsers}`);

  if (shutdownTimer) {
    console.log("🛑 Extinction annulée : un utilisateur est revenu.");
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }

  if (systemAudioWarning) {
    socket.emit("error_system", systemAudioWarning);
  }

  broadcast();

  if (state.now) {
    socket.emit("progress", {
      positionSec: computePosition(state.now),
      durationSec: state.now.durationSec ?? null,
      paused: state.control.paused,
      repeat: state.control.repeat,
      title: state.now.title,
    });
  }

  on(
    "play",
    async (payload: { url?: string; addedBy?: string; clientRequestId?: string }) => {
      // Respect controls received before this add (especially a queued clear),
      // while leaving unrelated media imports free to resolve concurrently.
      await controlTask;
      const revision = queueRevision;
      const clientRequestId = typeof payload?.clientRequestId === "string"
        ? payload.clientRequestId.trim().slice(0, 128) || undefined
        : undefined;
      const result = (ok: boolean, message?: string) => {
        const detail = message?.slice(0, 500);
        socket.emit("play_result", { clientRequestId, ok, message: detail });
        if (!ok && detail) socket.emit("toast", detail);
      };
      const cancelled = () => {
        if (revision === queueRevision && !isShuttingDown) return false;
        result(false, "Ajout annulé : la file a été vidée.");
        return true;
      };
      try {
        const raw = typeof payload?.url === "string" ? payload.url.trim() : "";
        const addedBy = typeof payload?.addedBy === "string"
          ? payload.addedBy.trim().slice(0, 32) || "anon"
          : "anon";

        if (!raw || raw.length > SECURITY_CONFIG.queueInputMaxLength) {
          result(false, `Entre un lien ou une recherche valide (${SECURITY_CONFIG.queueInputMaxLength} caractères maximum).`);
          return;
        }

        if (!isVirtualAudioRoutingReady() && !await refreshAudioRouting()) {
          result(false, "Lecture bloquée : le routage audio virtuel du serveur n'est pas prêt.");
          if (systemAudioWarning) socket.emit("error_system", systemAudioWarning);
          return;
        }
        if (cancelled()) return;

        if (!isProbablyUrl(raw)) {
          socket.emit("toast", "Recherche YouTube en cours...");

          const found = await resolveSearchTextToVideoUrl(raw);
          if (cancelled()) return;

          if (!found) {
            result(false, "Aucun résultat trouvé.");
            return;
          }

          queueService.enqueue({
            url: found.url,
            title: found.title || "Titre en attente...",
            thumb: found.thumb ?? null,
            durationSec: found.durationSec || 0,
            addedBy,
            clientRequestId,
          });

          finishQueueAdd(() => result(true));
          return;
        }

        const normalized = normalizeUrl(raw);

        if (isYoutubeSearchUrl(normalized)) {
          result(false, "Ce lien est une page de recherche YouTube, pas une vidéo.");
          return;
        }

        const spotify = isSpotifyUrl(normalized);
        const playlist = isPlaylistUrl(normalized);
        const soundcloudExpandable = isSoundCloudUrl(normalized);

        if (spotify || playlist || soundcloudExpandable) {
          socket.emit(
            "toast",
            soundcloudExpandable && !playlist
              ? "Analyse du lien SoundCloud..."
              : "Analyse de la playlist..."
          );

          const items = await resolveUrlToPlayableItems(normalized);
          if (cancelled()) return;

          if (!items.length) {
            result(false, "Aucun titre exploitable trouvé.");
            return;
          }

          queueService.enqueueCollection(items, { addedBy, clientRequestId });

          socket.emit(
            "toast",
            items.length > 1
              ? `${items.length} titres ajoutés !`
              : "Titre ajouté !"
          );
          finishQueueAdd(() => result(true));
          return;
        }

        const queued = queueService.enqueue({
          url: normalized,
          title: "Analyse du signal...",
          thumb: null,
          addedBy,
          clientRequestId,
        });

        finishQueueAdd(() => result(true), () => {
          void enrichQueuedItem(queued.id, normalized);
        });
      } catch (e) {
        console.error("[Play Error]", e);
        result(false, e instanceof Error ? e.message : "Erreur d'ajout.");
      }
    }
  );

  on("command", async (payload: { cmd?: string; arg?: unknown } | null) => {
    if (!payload || typeof payload.cmd !== "string") {
      throw new Error("Commande invalide");
    }
    const h = playing?.handle;

    switch (payload.cmd) {
      case "pause": {
        if (state.now?.startedAt) {
          state.now.positionOffsetSec = computePosition(state.now);
          state.now.startedAt = null;
        }
        state.control.paused = true;
        if (h) await mpvPause(h, true);
        break;
      }

      case "resume": {
        state.control.paused = false;

        if (state.now && !state.now.isBuffering) {
          state.now.startedAt =
            Date.now() - ((state.now.positionOffsetSec || 0) * 1000);
        }
        if (h) await mpvPause(h, false);
        break;
      }

      case "skip": {
        await skip(broadcast);
        break;
      }

      case "skip_group": {
        await skipGroup(broadcast);
        break;
      }

      case "previous": {
        await playPrevious(broadcast);
        break;
      }

      case "seek": {
        const delta = Number(payload.arg);
        if (!Number.isFinite(delta)) throw new Error("Position invalide");
        await seekRelative(delta, broadcast);
        break;
      }

      case "seek_abs": {
        if (typeof payload.arg !== "number") throw new Error("Position invalide");
        await seekAbsolute(payload.arg, broadcast);
        break;
      }

      case "repeat": {
        const isRepeat = Boolean(payload.arg);
        state.control.repeat = isRepeat;
        if (h) {
          await mpvSetLoopFile(h, isRepeat);
        }
        break;
      }

      case "audio_profile": {
        const profile = normalizeAudioProfileName(String(payload.arg || ""));
        state.control.audioProfile = profile;
        if (h) {
          await mpvSetAudioProfile(h, profile);
        }
        warmQueueIfPlaying();

        socket.emit(
          "toast",
          profile === "xbox"
            ? "Profil audio Xbox activé."
            : "Profil audio équilibré activé."
        );
        break;
      }

      case "random_mode": {
        state.control.randomMode = Boolean(payload.arg);
        warmQueueIfPlaying();
        break;
      }

      case "shuffle_queue": {
        queueService.shuffle();
        warmQueueIfPlaying();
        break;
      }
      default:
        throw new Error("Commande inconnue");
    }

    broadcast();
  }, true);

  on("clear", async () => {
    queueRevision++;
    queueService.clear();

    await stopPlayer(broadcast);
    broadcast();
  }, true);

  on("remove_queue_item", async (payload: { id?: string } | null) => {
    const id = payload?.id;
    if (typeof id !== "string") throw new Error("Identifiant invalide");
    const removed = queueService.remove(id);
    if (removed === "missing") return;

    if (removed === "playing") {
      await skip(broadcast);
    } else {
      warmQueueIfPlaying();
      broadcast();
    }
  }, true);

  on("reorder_queue", (payload: { ids?: unknown } | null) => {
    if (!Array.isArray(payload?.ids) || payload.ids.length > SECURITY_CONFIG.reorderMaxItems ||
      !payload.ids.every((id) => typeof id === "string")) {
      throw new Error("Ordre de file invalide");
    }
    queueService.reorder(payload.ids as string[]);
    warmQueueIfPlaying();
    broadcast();
  }, true);

  on(
    "requeue_history_item",
    async (payload: { id?: string; targetIndex?: number } | null) => {
      const { id, targetIndex } = payload || {};
      if (typeof id !== "string") throw new Error("Identifiant invalide");
      if (!isVirtualAudioRoutingReady() && !await refreshAudioRouting()) {
        socket.emit("toast", systemAudioWarning);
        return;
      }
      if (!queueService.requeueHistory(id, targetIndex)) return;
      finishQueueAdd();
    },
    true
  );

  socket.on("disconnect", () => {
    activeUsers = Math.max(0, activeUsers - 1);
    console.log(`👤 Client déconnecté. Restants: ${activeUsers}`);

    if (activeUsers === 0 && APP_CONFIG.idleShutdownMs > 0) {
      console.log(
        `⏳ Plus personne sur l'interface. Extinction dans ${APP_CONFIG.idleShutdownMs / 1000}s...`
      );

      shutdownTimer = setTimeout(() => {
        if (activeUsers === 0) void shutdown("inactivité");
      }, APP_CONFIG.idleShutdownMs);
    }
  });
});

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  queueRevision++;
  if (shutdownTimer) clearTimeout(shutdownTimer);
  const exitCode = Number(process.exitCode) || 0;
  setTimeout(() => process.exit(exitCode), 3_000).unref();

  console.log(`[server] ${signal} received, stopping player`);
  recordDiagnostic("SERVER_STOPPING");

  try {
    await stopPlayer(broadcast);
  } catch (error) {
    console.warn("[server] player shutdown failed", error);
  }

  await Promise.allSettled([diagnostics.flush(), flushProviderMatchCache()]);
  io.close(() => process.exit(exitCode));
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

/* --- BOOTSTRAP --- */

async function bootstrap() {
  await diagnostics.initialize();
  state.control.audioProfile = MPV_CONFIG.defaultAudioProfile;

  const audioReady = await refreshAudioRouting();
  const audioRouting = getRuntimeAudioRouting();

  if (audioRouting.message) {
    console.log(`[Audio] ${audioRouting.message}`);
  }

  if (audioReady) {
    ensureMpvRunning().catch(console.error);
  }

  server.listen(APP_CONFIG.PORT, () => {
    recordDiagnostic("SERVER_STARTED");
    void checkToolDiagnostics().catch(() => recordDiagnostic("TOOL_CHECK_WARNING"));
    console.log(`🚀 Server Ready on port ${APP_CONFIG.PORT}`);
  });
}

server.on("error", (error) => {
  recordDiagnostic("SERVER_START_FAILED", diagnosticErrorDetails(error));
  console.error("[server] HTTP server failed", error);
  process.exitCode = 1;
  void shutdown("erreur HTTP");
});

bootstrap().catch((error) => {
  recordDiagnostic("SERVER_START_FAILED", diagnosticErrorDetails(error));
  console.error("[server] Startup failed", error);
  process.exitCode = 1;
  void shutdown("erreur de démarrage");
});
