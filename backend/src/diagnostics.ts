import { appendFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DIAGNOSTICS_CONFIG } from "./config.js";
import type { DiagnosticDetails, DiagnosticEvent as SharedDiagnosticEvent } from "../../shared/contracts.js";
export type { DiagnosticDetails } from "../../shared/contracts.js";

type Level = SharedDiagnosticEvent["level"];
// Messages are a closed catalog: raw errors, titles, cookies and signed stream
// URLs can never accidentally be persisted or returned by the diagnostics API.
const EVENTS = {
  PROCESS_UNCAUGHT_EXCEPTION: ["error", "runtime", "Une erreur non interceptée impose l'arrêt du serveur."],
  PROCESS_UNHANDLED_REJECTION: ["error", "runtime", "Une opération asynchrone non gérée impose l'arrêt du serveur."],
  PROCESS_WARNING: ["warn", "runtime", "Node.js a signalé un avertissement de fonctionnement."],
  RUNTIME_HEARTBEAT: ["info", "runtime", "Le serveur est actif. Relevé périodique de mémoire et de réactivité."],
  SOCKET_CONNECTED: ["info", "server", "Une interface s'est connectée au serveur."],
  SOCKET_DISCONNECTED: ["info", "server", "Une interface s'est déconnectée du serveur."],
  SOCKET_RATE_LIMITED: ["warn", "server", "Des commandes ont été refusées temporairement car elles arrivaient trop vite."],
  QUEUE_ADD_STARTED: ["info", "queue", "L'analyse d'un ajout à la file a commencé."],
  QUEUE_ADD_SUCCEEDED: ["info", "queue", "L'ajout à la file a réussi."],
  QUEUE_ADD_FAILED: ["warn", "queue", "L'ajout à la file a échoué."],
  QUEUE_ADD_CANCELLED: ["info", "queue", "L'ajout en cours a été annulé."],
  MEDIA_RESOLUTION_FALLBACK: ["warn", "providers", "Une méthode de résolution a échoué. Une autre méthode sera essayée."],
  MEDIA_RESOLUTION_FAILED: ["error", "providers", "Aucune méthode n'a permis de résoudre cette source."],
  PROVIDER_CACHE_FAILED: ["warn", "cache", "Le cache de correspondances des fournisseurs est indisponible. La lecture peut continuer sans ce cache."],
  MPV_STREAM_FAILED: ["warn", "mpv", "Le flux audio a été refusé ou interrompu par mpv."],
  PLAYBACK_START_FAILED: ["warn", "player", "La tentative de démarrage de la piste a échoué."],
  SERVER_STARTED: ["info", "server", "Serveur démarré."],
  SERVER_STOPPING: ["info", "server", "Arrêt du serveur demandé."],
  SERVER_START_FAILED: ["error", "server", "Le serveur n'a pas pu démarrer."],
  SOCKET_COMMAND_FAILED: ["warn", "server", "Une commande a échoué ou contenait des données invalides."],
  DIAGNOSTICS_REQUEST_FAILED: ["warn", "server", "La préparation du diagnostic a échoué."],
  AUDIO_ROUTING_READY: ["info", "audio", "Le routage audio virtuel est prêt."],
  AUDIO_ROUTING_UNAVAILABLE: ["error", "audio", "Le routage audio virtuel est indisponible. Lecture bloquée."],
  MPV_STARTED: ["info", "mpv", "Le moteur mpv est prêt."],
  MPV_EXITED: ["warn", "mpv", "Le moteur mpv s'est arrêté de façon inattendue."],
  MPV_TRANSPORT_FAILED: ["error", "mpv", "La communication avec mpv a échoué."],
  PLAYBACK_RECOVERED: ["info", "player", "La lecture a progressé normalement après la reprise. Le budget de récupération est rétabli."],
  PLAYBACK_STARTED: ["info", "player", "La lecture d'une piste a démarré."],
  PLAYBACK_STALLED: ["warn", "player", "La lecture ne progresse plus depuis 60 secondes."],
  PLAYBACK_RETRY: ["warn", "player", "Nouvelle tentative de lecture avec une source fraîche."],
  PLAYBACK_ABANDONED: ["error", "player", "Piste abandonnée après les tentatives de récupération."],
  PLAYBACK_RESOLUTION_FAILED: ["error", "player", "La résolution ou le démarrage d'une piste a échoué."],
  SPOTIFY_TOKEN_REFRESHED: ["info", "spotify", "Une autorisation Spotify a été renouvelée."],
  SPOTIFY_TOKEN_REJECTED: ["warn", "spotify", "Spotify a refusé un jeton. Renouvellement demandé."],
  SPOTIFY_REFRESH_REVOKED: ["warn", "spotify", "L'autorisation utilisateur Spotify est expirée ou révoquée. Une reconnexion peut être nécessaire."],
  SPOTIFY_REQUEST_FAILED: ["error", "spotify", "Une requête Spotify a échoué."],
  SPOTIFY_REQUEST_RETRY: ["warn", "spotify", "Nouvelle tentative après une erreur temporaire de Spotify."],
  YTDLP_TIMEOUT: ["error", "ytdlp", "yt-dlp a dépassé son délai de résolution."],
  YTDLP_PROCESS_FAILED: ["warn", "ytdlp", "Une tentative d'extraction yt-dlp a échoué."],
  YTDLP_SOURCE_RESOLVED: ["info", "ytdlp", "Une source audio a été résolue par yt-dlp."],
  TOOL_CHECK_OK: ["info", "tools", "Les exécutables audio ont été vérifiés."],
  TOOL_CHECK_WARNING: ["warn", "tools", "Un exécutable audio est absent, ancien ou impossible à vérifier."],
} as const satisfies Record<string, readonly [Level, string, string]>;

export type DiagnosticCode = keyof typeof EVENTS;
export type DiagnosticEvent = Omit<SharedDiagnosticEvent, "code"> & { code: DiagnosticCode };

const REASONS = new Set([
  "timeout", "network", "unauthorized", "forbidden", "rate_limit", "unavailable",
  "client_disconnect", "server_disconnect", "transport_close", "transport_error", "ping_timeout", "parse_error", "cancelled", "shutdown",
  "listener_limit", "deprecated", "uncaught_exception", "unhandled_rejection", "SIGINT", "SIGTERM", "idle", "startup_failed", "http_error",
  "ENOENT", "EACCES", "EPERM", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EADDRINUSE", "unknown",
]);

function safeDetails(input: DiagnosticDetails = {}): DiagnosticDetails | undefined {
  const result: DiagnosticDetails = {};
  for (const key of ["status", "exitCode", "durationMs", "attempt", "activeUsers", "itemCount", "uptimeSec", "rssMB", "heapUsedMB", "lagMs"] as const) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      if (key === "status" && (value < 100 || value > 599)) continue;
      result[key] = Math.min(Math.round(value), 2_147_483_647);
    }
  }
  if (typeof input.platform === "string" && ["youtube", "spotify", "soundcloud", "twitch", "direct", "generic", "unknown"].includes(input.platform)) result.platform = input.platform;
  if (typeof input.stage === "string" && ["search", "metadata", "playlist", "shortlink", "extraction", "cache_load", "cache_write"].includes(input.stage)) result.stage = input.stage;
  if (typeof input.trackId === "string" && /^\d{1,12}$/.test(input.trackId)) result.trackId = input.trackId;
  if (typeof input.reason === "string" && REASONS.has(input.reason)) result.reason = input.reason;
  return Object.keys(result).length ? result : undefined;
}

export function diagnosticErrorDetails(error: unknown): DiagnosticDetails {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = typeof value.message === "string" ? value.message : "";
  const status = typeof value.status === "number" ? value.status : Number(message.match(/\b(401|403|404|429|5\d\d)\b/)?.[1]);
  const reason = typeof value.code === "string" && REASONS.has(value.code) ? value.code
    : /timeout|timed out|délai/i.test(message) ? "timeout"
    : status === 401 ? "unauthorized" : status === 403 ? "forbidden"
    : status === 429 ? "rate_limit" : /network|fetch failed|connexion/i.test(message) ? "network" : "unknown";
  return safeDetails({ status, reason }) || { reason: "unknown" };
}

type StoreOptions = { enabled: boolean; directory: string; maxBytes: number; maxFiles: number; maxEvents: number };

export function createDiagnosticStore(options: StoreOptions) {
  const filename = path.join(options.directory, "events.ndjson");
  const runId = randomUUID();
  const maxBytes = Math.max(1024, options.maxBytes);
  const maxFiles = Math.max(1, Math.min(10, options.maxFiles));
  const maxEvents = Math.max(1, Math.min(1000, options.maxEvents));
  let recent: DiagnosticEvent[] = [];
  let available = false;
  let droppedWrites = 0;
  let pendingWrites = 0;
  let initialized: Promise<void> | null = null;
  let writes = Promise.resolve();

  const initialize = () => {
    if (initialized) return initialized;
    initialized = (async () => {
      if (!options.enabled) return;
      try {
        await mkdir(options.directory, { recursive: true, mode: 0o700 });
        const loaded: DiagnosticEvent[] = [];
        for (let archive = maxFiles - 1; archive >= 0; archive--) {
          let handle;
          try {
            handle = await open(archive === 0 ? filename : `${filename}.${archive}`, "r");
            const size = (await handle.stat()).size;
            const start = Math.max(0, size - Math.min(maxBytes, 262_144));
            const buffer = Buffer.alloc(Math.min(size - start, 262_144));
            await handle.read(buffer, 0, buffer.length, start);
            const lines = buffer.toString("utf8").split("\n");
            if (start > 0) lines.shift();
            for (const line of lines) {
              try {
                const data = JSON.parse(line);
                if (!data || typeof data.code !== "string" || !Object.hasOwn(EVENTS, data.code) ||
                    typeof data.timestamp !== "string" || !Number.isFinite(Date.parse(data.timestamp))) continue;
                const code = data.code as DiagnosticCode;
                const [level, category, message] = EVENTS[code];
                loaded.push({ ...(typeof data.runId === "string" && /^[a-f0-9-]{36}$/.test(data.runId) ? { runId: data.runId } : {}), timestamp: new Date(data.timestamp).toISOString(), level, category, code, message, details: safeDetails(data.details) });
              } catch { /* Ignore a truncated or corrupted line after a crash. */ }
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          } finally { await handle?.close(); }
        }
        recent = [...loaded, ...recent].slice(-maxEvents);
        available = true;
      } catch { available = false; }
    })();
    return initialized;
  };

  const record = (code: DiagnosticCode, details?: DiagnosticDetails) => {
    const [level, category, message] = EVENTS[code];
    const event: DiagnosticEvent = { runId, timestamp: new Date().toISOString(), level, category, code, message, details: safeDetails(details) };
    recent.push(event);
    recent = recent.slice(-maxEvents);
    if (!options.enabled) return;
    // Reserve space for fatal causes even after a burst of ordinary events.
    const maxPending = code === "PROCESS_UNCAUGHT_EXCEPTION" || code === "PROCESS_UNHANDLED_REJECTION" ? 202 : 200;
    if (pendingWrites >= maxPending) { droppedWrites++; return; }
    pendingWrites++;
    writes = writes.then(async () => {
      await initialize();
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      // A crash can leave a partial final line. A leading separator ensures
      // the next valid event survives even when that fragment is still there.
      const line = "\n" + JSON.stringify(event) + "\n";
      const size = await stat(filename).then((entry) => entry.size, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      });
      if (size + Buffer.byteLength(line) > maxBytes) {
        if (maxFiles === 1) await rm(filename, { force: true });
        else {
          await rm(`${filename}.${maxFiles - 1}`, { force: true });
          for (let index = maxFiles - 2; index >= 0; index--) {
            const source = index === 0 ? filename : `${filename}.${index}`;
            try { await rename(source, `${filename}.${index + 1}`); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
        }
      }
      await appendFile(filename, line, { mode: 0o600 });
      available = true;
    }).catch(() => { available = false; droppedWrites++; }).finally(() => { pendingWrites--; });
  };

  return {
    initialize,
    record,
    events: () => recent.slice().reverse().map((event) => ({ ...event, details: event.details && { ...event.details } })),
    status: () => ({ enabled: options.enabled, available, droppedWrites, runId }),
    flush: () => writes,
  };
}

export const diagnostics = createDiagnosticStore(DIAGNOSTICS_CONFIG);
export const recordDiagnostic = diagnostics.record;
