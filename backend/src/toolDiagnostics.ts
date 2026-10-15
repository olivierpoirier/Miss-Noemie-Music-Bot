import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { MPV_CONFIG, YTDLP_CONFIG } from "./config.js";
import { recordDiagnostic } from "./diagnostics.js";
import type { DiagnosticTool } from "../../shared/contracts.js";

export type ToolDiagnostic = DiagnosticTool;

async function executablePath(command: string): Promise<string> {
  const hasPath = path.isAbsolute(command) || /[/\\]/.test(command);
  const directories = hasPath ? [""] : (process.env.PATH || "").split(path.delimiter);
  const extensions = process.platform === "win32" && !path.extname(command)
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = hasPath ? path.resolve(command + extension) : path.resolve(directory, command + extension);
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* Let spawn report a missing or inaccessible executable. */ }
    }
  }
  return command;
}

export function parseToolVersion(tool: "ytDlp" | "mpv", output: string, atMs = Date.now()) {
  if (tool === "mpv") {
    const version = output.match(/^mpv(?:net)?\s+([a-zA-Z0-9.+_~-]{1,64})/im)?.[1] || null;
    return { version, ageDays: null };
  }
  const version = output.trim().match(/^(\d{4}\.\d{2}\.\d{2}(?:[a-zA-Z0-9.+_-]*)?)(?:\s|$)/)?.[1] || null;
  if (!version) return { version: null, ageDays: null };
  const [year, month, day] = version.slice(0, 10).split(".").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { version: null, ageDays: null };
  }
  return { version, ageDays: Math.max(0, Math.floor((atMs - date.getTime()) / 86_400_000)) };
}

type Probe = (command: string) => Promise<{ output: string; ok: boolean }>;

export const probeVersion: Probe = (command) => new Promise((resolve) => {
  // --version never loads a track, opens an audio device or contacts a service.
  const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  let settled = false;
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve({ output, ok });
  };
  const timeout = setTimeout(() => { child.kill("SIGKILL"); finish(false); }, 4_000);
  child.stdout.on("data", (chunk) => {
    if (settled) return;
    output += chunk.toString();
    if (Buffer.byteLength(output) > 16_384) { child.kill("SIGKILL"); finish(false); }
  });
  child.stderr.on("data", () => { /* Do not expose arbitrary subprocess output. */ });
  child.once("error", () => finish(false));
  child.once("close", (code) => finish(code === 0));
});

export function createToolInspector(
  bins: { ytDlp: string; mpv: string },
  probe: Probe = probeVersion,
  clock: () => number = Date.now
) {
  const initial = (bin: string): ToolDiagnostic => ({ path: bin, version: null, checkedAt: null, status: "unchecked", ageDays: null, message: "Vérification en attente." });
  let tools = { ytDlp: initial(bins.ytDlp), mpv: initial(bins.mpv) };
  let checkedAt = -Infinity;
  let pending: Promise<typeof tools> | null = null;

  const check = (force = false): Promise<typeof tools> => {
    if (pending) return pending;
    if (!force && clock() - checkedAt < 600_000) return Promise.resolve(snapshot());
    pending = (async () => {
      const entries = await Promise.all((["ytDlp", "mpv"] as const).map(async (tool) => {
        const executable = await executablePath(bins[tool]);
        const atMs = clock();
        let result: Awaited<ReturnType<Probe>>;
        try { result = await probe(executable); }
        catch { result = { output: "", ok: false }; }
        const parsed = result.ok ? parseToolVersion(tool, result.output, atMs) : { version: null, ageDays: null };
        const info: ToolDiagnostic = {
          path: executable, ...parsed, checkedAt: new Date(atMs).toISOString(),
          status: !result.ok ? "error" : !parsed.version || (tool === "ytDlp" && (parsed.ageDays || 0) > 90) ? "warning" : "ok",
          message: !result.ok ? "Exécutable introuvable ou vérification impossible. Vérifie le chemin et les permissions."
            : !parsed.version ? "L'exécutable répond, mais sa version n'a pas pu être identifiée."
            : tool === "ytDlp" && (parsed.ageDays || 0) > 90
              ? "Cette copie de yt-dlp a plus de 90 jours. Une mise à jour peut résoudre des refus de YouTube."
              : "Exécutable disponible.",
        };
        return [tool, info] as const;
      }));
      tools = Object.fromEntries(entries) as typeof tools;
      checkedAt = clock();
      return snapshot();
    })().finally(() => { pending = null; });
    return pending;
  };
  const snapshot = () => ({ ytDlp: { ...tools.ytDlp }, mpv: { ...tools.mpv } });
  return { check, snapshot };
}

const inspector = createToolInspector({ ytDlp: YTDLP_CONFIG.bin, mpv: MPV_CONFIG.bin });
export const getToolDiagnostics = inspector.snapshot;
let recordedCheck: string | null = null;
export async function checkToolDiagnostics() {
  const tools = await inspector.check();
  if (tools.ytDlp.checkedAt !== recordedCheck) {
    recordedCheck = tools.ytDlp.checkedAt;
    recordDiagnostic(Object.values(tools).every((tool) => tool.status === "ok") ? "TOOL_CHECK_OK" : "TOOL_CHECK_WARNING");
  }
  return tools;
}
