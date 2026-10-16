import type { DiagnosticDetails, DiagnosticSnapshot, DiagnosticTool } from "../../../shared/contracts.js";
export type { DiagnosticDetails, DiagnosticEvent, DiagnosticSnapshot, DiagnosticTool } from "../../../shared/contracts.js";

export const DIAGNOSTIC_REQUEST_TIMEOUT = 8_000;
export const DIAGNOSTIC_POLL_INTERVAL = 15_000;

const invalidResponse = () => new Error("Le serveur a renvoyé des diagnostics invalides.");

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw invalidResponse();
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invalidResponse();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalidResponse();
  return value;
}

function timestamp(value: unknown): string {
  const text = string(value);
  if (!Number.isFinite(Date.parse(text))) throw invalidResponse();
  return text;
}

function tool(value: unknown): DiagnosticTool {
  const data = record(value);
  const status = data.status;
  if (status !== "ok" && status !== "warning" && status !== "error" && status !== "unchecked") {
    throw invalidResponse();
  }
  return {
    path: string(data.path),
    version: data.version === null ? null : string(data.version),
    checkedAt: data.checkedAt === null ? null : timestamp(data.checkedAt),
    status,
    ageDays: data.ageDays == null ? null : number(data.ageDays),
    message: string(data.message),
  };
}

function details(value: unknown): DiagnosticDetails | undefined {
  if (value == null) return undefined;
  const data = record(value);
  const result: DiagnosticDetails = {};
  for (const key of ["status", "exitCode", "durationMs", "attempt", "activeUsers", "itemCount", "uptimeSec", "rssMB", "heapUsedMB", "lagMs"] as const) {
    if (data[key] !== undefined) result[key] = number(data[key]);
  }
  if (typeof data.platform === "string" && ["youtube", "spotify", "soundcloud", "twitch", "direct", "generic", "unknown"].includes(data.platform)) result.platform = data.platform;
  if (typeof data.stage === "string" && ["search", "metadata", "playlist", "shortlink", "extraction", "cache_load", "cache_write"].includes(data.stage)) result.stage = data.stage;
  if (typeof data.trackId === "string" && /^\d{1,12}$/.test(data.trackId)) result.trackId = data.trackId;
  if (typeof data.reason === "string" && [
    "timeout", "network", "unauthorized", "forbidden", "rate_limit", "unavailable",
    "client_disconnect", "server_disconnect", "transport_close", "transport_error", "ping_timeout", "parse_error", "cancelled", "shutdown",
    "listener_limit", "deprecated", "uncaught_exception", "unhandled_rejection", "SIGINT", "SIGTERM", "idle", "startup_failed", "http_error",
    "ENOENT", "EACCES", "EPERM", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EADDRINUSE", "unknown",
  ].includes(data.reason)) result.reason = data.reason;
  return Object.keys(result).length ? result : undefined;
}

/** Keep only the documented public fields, including in downloaded reports. */
export function parseDiagnostics(value: unknown): DiagnosticSnapshot {
  const data = record(value);
  if (data.ok !== true || !Array.isArray(data.recentEvents)) throw invalidResponse();
  const server = record(data.server);
  const player = record(data.player);
  const audio = record(data.audioRouting);
  const tools = record(data.tools);
  const logging = record(data.logging);
  return {
    ok: true,
    timestamp: timestamp(data.timestamp),
    server: {
      uptimeSec: number(server.uptimeSec),
      activeUsers: number(server.activeUsers),
      queued: number(server.queued),
      idleShutdownMs: number(server.idleShutdownMs),
    },
    player: {
      engineRunning: boolean(player.engineRunning),
      starting: boolean(player.starting),
      loading: boolean(player.loading),
      buffering: boolean(player.buffering),
      paused: boolean(player.paused),
      retryCount: number(player.retryCount),
    },
    audioRouting: {
      ready: boolean(audio.ready),
      degraded: boolean(audio.degraded),
      message: audio.message === null ? null : string(audio.message),
    },
    tools: {
      ytDlp: tool(tools.ytDlp),
      ...(tools.mpv == null ? {} : { mpv: tool(tools.mpv) }),
    },
    recentEvents: data.recentEvents.map((value): DiagnosticSnapshot["recentEvents"][number] => {
      const event = record(value);
      const level = event.level;
      if (level !== "info" && level !== "warn" && level !== "error") throw invalidResponse();
      const safeDetails = details(event.details);
      return {
        ...(typeof event.runId === "string" && /^[a-f0-9-]{36}$/.test(event.runId) ? { runId: event.runId } : {}),
        timestamp: timestamp(event.timestamp),
        level,
        category: string(event.category),
        code: string(event.code),
        message: string(event.message),
        ...(safeDetails ? { details: safeDetails } : {}),
      };
    }).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 100),
    logging: {
      enabled: boolean(logging.enabled), available: boolean(logging.available),
      ...(logging.droppedWrites === undefined ? {} : { droppedWrites: number(logging.droppedWrites) }),
      ...(typeof logging.runId === "string" && /^[a-f0-9-]{36}$/.test(logging.runId) ? { runId: logging.runId } : {}),
    },
  };
}

export async function requestDiagnostics(
  options: { baseUrl?: string; signal?: AbortSignal } = {}
): Promise<DiagnosticSnapshot> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, DIAGNOSTIC_REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${(options.baseUrl || "").replace(/\/$/, "")}/diagnostics`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Diagnostics indisponibles (HTTP ${response.status}).`);
    return parseDiagnostics(await response.json());
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error("Le serveur met trop de temps à répondre aux diagnostics.");
    }
    if (error instanceof SyntaxError) throw invalidResponse();
    throw error;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", abort);
  }
}
