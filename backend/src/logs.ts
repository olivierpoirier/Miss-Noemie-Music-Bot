import "dotenv/config";
import path from "node:path";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { DIAGNOSTICS_CONFIG } from "./config.js";
import { createDiagnosticStore, type DiagnosticEvent } from "./diagnostics.js";

function print(event: DiagnosticEvent): void {
  const session = event.runId ? ` [${event.runId.slice(0, 8)}]` : "";
  const details = event.details ? ` ${JSON.stringify(event.details)}` : "";
  console.log(`${event.timestamp}${session} ${event.level.toUpperCase()} ${event.code}: ${event.message}${details}`);
}

async function readEvents() {
  // Read the existing journal even when this process has disk logging disabled.
  // Loading rebuilds catalog messages and filters every public detail again.
  const reader = createDiagnosticStore({ ...DIAGNOSTICS_CONFIG, enabled: true, maxEvents: 1_000 });
  await reader.initialize();
  if (!reader.status().available) throw new Error("Journal indisponible. Vérifie le dossier de logs et ses permissions.");
  return reader.events().reverse();
}

async function fingerprint() {
  return Promise.all(Array.from({ length: DIAGNOSTICS_CONFIG.maxFiles }, async (_, index) => {
    const filename = path.join(DIAGNOSTICS_CONFIG.directory, `events.ndjson${index ? `.${index}` : ""}`);
    try {
      const info = await stat(filename);
      return `${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw new Error("Journal indisponible. Vérifie le dossier de logs et ses permissions.");
    }
  })).then((entries) => entries.join("|"));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("npm run logs : 100 derniers événements; npm run logs -- --follow : suivre les nouveaux événements.");
    return;
  }
  if (args.some((arg) => arg !== "--follow" && arg !== "-f")) throw new Error("Option inconnue. Utilise --follow ou --help.");
  const follow = args.includes("--follow") || args.includes("-f");
  let previousFingerprint = await fingerprint();
  let events = await readEvents();
  events.slice(-100).forEach(print);
  if (!events.length) console.log("Aucun événement enregistré. Démarre le bot pour alimenter le journal.");
  if (!follow) return;
  console.log("Suivi du journal actif (Ctrl+C pour quitter). Les rotations sont prises en compte.");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!controller.signal.aborted) {
      try { await delay(1_000, undefined, { signal: controller.signal }); }
      catch { break; }
      const currentFingerprint = await fingerprint();
      if (currentFingerprint === previousFingerprint) continue;
      previousFingerprint = currentFingerprint;
      const seen = new Map<string, number>();
      for (const event of events) {
        const key = JSON.stringify(event);
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      events = await readEvents();
      for (const event of events) {
        const key = JSON.stringify(event);
        const remaining = seen.get(key) || 0;
        if (remaining) seen.set(key, remaining - 1);
        else print(event);
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Impossible de lire le journal.");
  process.exitCode = 1;
});
