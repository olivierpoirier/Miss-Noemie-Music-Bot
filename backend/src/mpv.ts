import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import crypto from "crypto";
import { recordDiagnostic, diagnosticErrorDetails } from "./diagnostics.js";
import { EventEmitter } from "events";
import { MPV_CONFIG } from "./config.js";
import {
  getAudioProfileConfig,
  normalizeAudioProfileName,
  type AudioProfileName,
} from "./audioProfiles.js";
import { getRuntimeAudioRouting, isVirtualAudioRoutingReady } from "./utils.js";
import { MpvEvent, MpvHandle } from "./types.js";

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/* ------------------- UTILS ------------------- */

function findPlayerBinary(): string {
  const bin = MPV_CONFIG.bin;
  if (bin) return bin;

  const ok = (cmd: string): boolean => {
    try {
      return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
    } catch {
      return false;
    }
  };

  if (ok("mpv")) return "mpv";
  if (ok("mpvnet")) return "mpvnet";

  throw new Error(
    "❌ Exécutable MPV introuvable. Vérifiez votre installation ou votre fichier .env"
  );
}

function buildAudioArgs(ipcPath: string): string[] {
  const routing = getRuntimeAudioRouting();

  if (!isVirtualAudioRoutingReady() || !routing.audioDevice) {
    throw new Error(
      "Routage audio virtuel absent : MPV refuse de dÃ©marrer sans entrÃ©e virtuelle."
    );
  }

  const args: string[] = [
    ...MPV_CONFIG.baseArgs,
    `--volume=${getAudioProfileConfig(MPV_CONFIG.defaultAudioProfile).volume}`,
    `--input-ipc-server=${ipcPath}`,
    `--user-agent=${MPV_CONFIG.userAgent}`,
    "--msg-level=all=warn,cplayer=info",
  ];

  const startupFilters = getAudioProfileConfig(
    MPV_CONFIG.defaultAudioProfile
  ).filters;

  if (startupFilters) {
    args.push(`--af=${startupFilters}`);
  }

  args.push(`--audio-device=${routing.audioDevice}`);

  return args;
}

/* ------------------- MPV INSTANCE ------------------- */

export class MpvInstance extends EventEmitter {
  public proc: ChildProcess;
  public sock: net.Socket | null = null;
  public started = false;

  private ipcPath: string;
  private buffer = "";
  private startError: Error | null = null;
  private terminalError: Error | null = null;
  private awaitingFileStart = false;
  private requestId = 0;
  private commands = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  private playbackWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private lastLogs: string[] = [];

  constructor(proc: ChildProcess, ipcPath: string) {
    super();
    this.proc = proc;
    this.ipcPath = ipcPath;
    this.setupProcessListeners();
  }

  public async initialize(): Promise<void> {
    try {
      this.sock = await this.connectIpc();
      this.setupSocketListeners();

      await this.send({ command: ["observe_property", 1, "duration"] });
      await this.send({ command: ["observe_property", 2, "idle-active"] });
      await this.send({ command: ["observe_property", 3, "time-pos"] });
      await this.send({ command: ["observe_property", 4, "paused-for-cache"] });
      await this.send({ command: ["set_property", "pause", true] });
    } catch (err) {
      this.handleCrash();
      throw err;
    }
  }

  public send(cmd: Record<string, any>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.sock || this.sock.destroyed || !this.sock.writable) {
        reject(this.terminalError || new Error("Connexion IPC MPV indisponible"));
        return;
      }

      const requestId = ++this.requestId;
      const timeout = setTimeout(() => {
        this.commands.delete(requestId);
        const error = new Error("Timeout commande IPC MPV");
        reject(error);
        this.failTransport(error);
      }, MPV_CONFIG.ipcConnectTimeoutMs);
      this.commands.set(requestId, {
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });

      try {
        this.sock.write(JSON.stringify({ ...cmd, request_id: requestId }) + "\n", (error) => {
          if (error) this.failTransport(error);
        });
      } catch (error) {
        this.failTransport(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public kill(): void {
    this.failTransport(new Error("MPV arrêté"), false);
    this.removeAllListeners();

    try {
      if (this.sock) {
        this.sock.destroy();
        this.sock = null;
      }
    } catch {}

    if (this.proc.pid) {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", this.proc.pid.toString(), "/f", "/t"], {
          stdio: "ignore", windowsHide: true,
        }).on("error", (error) => console.warn("[mpv] taskkill failed:", error));
      } else {
        this.proc.kill("SIGKILL");
      }
    }
  }

  public waitForPlaybackStart(
    timeoutMs = MPV_CONFIG.globalStartTimeoutMs
  ): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.started) return Promise.resolve();
    if (this.startError) return Promise.reject(this.startError);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.playbackWaiters.delete(waiter);
        reject(new Error(`Timeout lecture mpv ${timeoutMs}ms`));
      }, timeoutMs);

      const waiter = {
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: (error: Error) => { clearTimeout(timeout); reject(error); },
      };
      this.playbackWaiters.add(waiter);
    });
  }

  public prepareForPlayback(): void {
    this.settlePlayback(new Error("Lecture MPV remplacée"));
    this.started = false;
    this.startError = null;
    this.awaitingFileStart = true;
  }

  /* ------------------- PRIVATE ------------------- */

  private setupProcessListeners(): void {
    const capture = (data: Buffer) => {
      const line = data.toString().trim();
      if (!line) return;

      if (
        line.includes("segment") ||
        line.includes("Opening 'https") ||
        line.includes("libavformat")
      ) {
        this.lastLogs.push(`[SILENT] ${line}`);
        if (this.lastLogs.length > 50) this.lastLogs.shift();
        return;
      }

      if (line.includes("403 Forbidden")) {
        console.error("🛑 [MPV] Erreur 403 pendant la lecture du flux audio.");
        return;
      }

      if (line.includes("Failed to open")) {
        console.warn("⚠️ [MPV] Échec d'ouverture d'un flux/segment.");
        return;
      }

      this.lastLogs.push(line);
      if (this.lastLogs.length > 50) this.lastLogs.shift();

      if (line.includes("[cplayer]") || line.includes("Error")) {
        console.log(`[MPV-CORE] ${line}`);
      }
    };

    this.proc.stdout?.on("data", capture);
    this.proc.stderr?.on("data", capture);
    this.proc.on("error", (err) => {
      console.error("[SYSTEM-ERROR] Impossible de lancer MPV :", err);
      this.failTransport(err);
    });
    this.proc.once("exit", (code, signal) => {
      this.failTransport(new Error(`MPV terminé (${signal || code})`), false);
      if (process.platform !== "win32") {
        try { fs.unlinkSync(this.ipcPath); } catch {}
      }
    });
  }

  private setupSocketListeners(): void {
    if (!this.sock) return;

    this.sock.setEncoding("utf8");
    this.sock.on("error", (error) => this.failTransport(error));
    this.sock.on("close", () => this.failTransport(new Error("Connexion IPC MPV fermée")));

    this.sock.on("data", (chunk: string) => {
      this.buffer += chunk;

      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          this.processMessage(JSON.parse(line));
        } catch {
          // ignore les lignes JSON incomplètes
        }
      }
    });
  }

  private processMessage(obj: any): void {
    if (typeof obj?.request_id === "number") {
      const pending = this.commands.get(obj.request_id);
      if (pending) {
        this.commands.delete(obj.request_id);
        if (obj.error && obj.error !== "success") {
          pending.reject(new Error(`Commande MPV refusée : ${obj.error}`));
        } else {
          pending.resolve();
        }
      }
    }

    let eventToEmit: MpvEvent | null = null;

    if (obj?.event === "start-file") {
      this.awaitingFileStart = false;
    } else if (obj?.event === "file-loaded") {
      if (this.awaitingFileStart) return;
      // A paused file can load successfully without playback-restart/time-pos.
      this.markStarted();
      eventToEmit = { type: "file-loaded" };
    } else if (obj?.event === "playback-restart") {
      if (this.awaitingFileStart) return;
      this.markStarted();
      eventToEmit = { type: "playback-restart" };
    } else if (obj?.event === "end-file") {
      // loadfile replace first ends the old file; that event belongs to the
      // previous attempt until MPV announces start-file for the replacement.
      if (this.awaitingFileStart) return;
      const reason = typeof obj.reason === "string" ? obj.reason : undefined;
      const error = typeof obj.error === "string" ? obj.error : undefined;

      if (!this.started || reason === "error") {
        this.started = false;
        this.startError = new Error(
          `MPV n'a pas pu ouvrir le flux${reason ? ` (${reason})` : ""}${
            error ? `: ${error}` : ""
          }`
        );
        this.settlePlayback(this.startError);
      }

      eventToEmit = { type: "end-file", reason, error };
    } else if (
      obj?.event === "property-change" &&
      typeof obj.name === "string"
    ) {
      if (this.awaitingFileStart) return;
      eventToEmit = {
        type: "property-change",
        name: obj.name,
        data: obj.data,
      };

      if (
        obj.name === "time-pos" &&
        !this.started &&
        typeof obj.data === "number"
      ) {
        this.markStarted();
      }
    }

    if (eventToEmit) {
      this.emit("mpv-event", eventToEmit);
      this.emit(eventToEmit.type, eventToEmit);
    }
  }

  private markStarted(): void {
    this.started = true;
    this.settlePlayback();
  }

  private settlePlayback(error?: Error): void {
    for (const waiter of this.playbackWaiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
    this.playbackWaiters.clear();
  }

  private failTransport(error: Error, terminate = true): void {
    if (this.terminalError) return;
    if (terminate) recordDiagnostic("MPV_TRANSPORT_FAILED", diagnosticErrorDetails(error));
    this.terminalError = error;
    this.startError = error;
    this.settlePlayback(error);
    for (const pending of this.commands.values()) pending.reject(error);
    this.commands.clear();
    this.sock?.destroy();
    if (terminate && this.proc.pid && this.proc.exitCode === null) {
      this.proc.kill("SIGKILL");
    }
  }

  private async connectIpc(
    timeoutMs = MPV_CONFIG.ipcConnectTimeoutMs
  ): Promise<net.Socket> {
    const start = Date.now();
    let delay = 100;

    while (Date.now() - start < timeoutMs) {
      if (this.terminalError || this.proc.exitCode !== null || this.proc.signalCode !== null) {
        throw this.terminalError || new Error("MPV a crashé avant connexion IPC");
      }

      try {
        const socket = net.connect(this.ipcPath as any);

        return await new Promise<net.Socket>((resolve, reject) => {
          const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error("Timeout connexion IPC MPV"));
          }, Math.min(500, timeoutMs - (Date.now() - start)));
          socket.once("connect", () => {
            clearTimeout(timeout);
            resolve(socket);
          });

          socket.once("error", (err) => {
            clearTimeout(timeout);
            socket.destroy();
            reject(err);
          });
        });
      } catch {
        await wait(delay);
        delay = Math.min(delay * 1.5, 500);
      }
    }

    throw new Error("Timeout connexion IPC MPV");
  }

  private handleCrash(): void {
    if (this.proc.pid) {
      console.error("\n--- ANALYSE DU CRASH MPV ---");
      console.error(this.lastLogs.slice(-10).join("\n"));
      console.error("-----------------------------\n");
      this.proc.kill("SIGKILL");
    }
  }
}

/* ------------------- START ------------------- */

export async function startMpv(url: string): Promise<MpvHandle> {
  const bin = findPlayerBinary();
  const id = crypto.randomBytes(4).toString("hex");
  const ipcPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\xmb_ipc_${id}`
      : `/tmp/xmb_mpv_${id}.sock`;

  try {
    if (process.platform !== "win32" && fs.existsSync(ipcPath)) {
      fs.unlinkSync(ipcPath);
    }
  } catch {}

  const args = buildAudioArgs(ipcPath);
  if (url?.trim()) args.push(url);

  console.log(`[DEBUG] Cmd: ${bin} ${args.join(" ")}`);

  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

  const instance = new MpvInstance(proc, ipcPath);
  await instance.initialize();

  return {
    proc: instance.proc,
    sock: instance.sock,

    send: instance.send.bind(instance),

    command: async (cmd: string, args?: any[]) => {
      const payload = args ? [cmd, ...args] : [cmd];
      await instance.send({ command: payload });
    },

    waitForPlaybackStart: instance.waitForPlaybackStart.bind(instance),

    prepareForPlayback: instance.prepareForPlayback.bind(instance),

    on: (listener) => {
      instance.on("mpv-event", listener);
    },

    off: (listener) => {
      instance.off("mpv-event", listener);
    },

    removeListener: (listener) => {
      instance.off("mpv-event", listener);
    },

    kill: instance.kill.bind(instance),
  };
}

/* ------------------- HELPERS ------------------- */

async function safeSend(
  h: MpvHandle,
  cmd: Record<string, any>,
  context: string
) {
  try {
    await h.send(cmd);
  } catch (err) {
    console.error(`[mpv] ${context} error:`, err);
    throw err;
  }
}

export const mpvPause = (h: MpvHandle, on: boolean) =>
  safeSend(h, { command: ["set_property", "pause", on] }, "pause");

export const mpvStop = (h: MpvHandle) =>
  safeSend(h, { command: ["stop"] }, "stop");

export const mpvQuit = (h: MpvHandle) =>
  safeSend(h, { command: ["quit"] }, "quit");

export const mpvSetLoopFile = (h: MpvHandle, on: boolean) =>
  safeSend(
    h,
    { command: ["set_property", "loop-file", on ? "inf" : "no"] },
    "loop"
  );

export const mpvSeekAbsolute = (h: MpvHandle, sec: number) =>
  safeSend(
    h,
    { command: ["set_property", "time-pos", Math.max(0, sec)] },
    "seek"
  );

export const mpvSetHttpHeaders = (h: MpvHandle, headers: string[]) =>
  safeSend(
    h,
    { command: ["set_property", "http-header-fields", headers] },
    "headers"
  );

export const mpvSetAudioProfile = async (
  h: MpvHandle,
  profile: AudioProfileName
) => {
  const normalized = normalizeAudioProfileName(profile);
  const config = getAudioProfileConfig(normalized);

  await safeSend(
    h,
    { command: ["set_property", "volume", config.volume] },
    "audio-profile-volume"
  );

  await safeSend(
    h,
    { command: ["set_property", "af", config.filters || ""] },
    "audio-profile-filter"
  );
};

export const mpvLoadFile = (h: MpvHandle, url: string, append = false) => {
  h.prepareForPlayback();
  return safeSend(
    h,
    { command: ["loadfile", url, append ? "append" : "replace"] },
    "load"
  );
};
