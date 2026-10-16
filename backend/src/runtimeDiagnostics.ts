import { performance } from "node:perf_hooks";
import { DIAGNOSTICS_CONFIG } from "./config.js";
import { diagnostics, diagnosticErrorDetails, recordDiagnostic } from "./diagnostics.js";

type FatalReason = "uncaught_exception" | "unhandled_rejection";

/** Install once in the server, never in the maintenance commands. */
export function installRuntimeDiagnostics(options: {
  onFatal: (reason: FatalReason) => void | Promise<void>;
  intervalMs?: number;
}): () => void {
  let failing = false;
  const fail = (reason: FatalReason, error: unknown) => {
    if (failing) return;
    failing = true;
    process.exitCode = 1;
    recordDiagnostic(reason === "uncaught_exception" ? "PROCESS_UNCAUGHT_EXCEPTION" : "PROCESS_UNHANDLED_REJECTION", diagnosticErrorDetails(error));
    console.error(`[runtime] ${reason}: arrêt du serveur; consulter le journal de diagnostic.`);
    // A broken shutdown or disk must not leave a half-failed server running.
    const deadline = setTimeout(() => process.exit(1), 3_000);
    deadline.unref();
    void Promise.resolve().then(() => options.onFatal(reason)).catch(() => {
      console.error("[runtime] La fermeture du serveur n'a pas pu se terminer normalement.");
    }).then(() => diagnostics.flush()).finally(() => process.exit(1));
  };
  process.on("uncaughtException", (error, origin) => fail(origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception", error));
  process.on("unhandledRejection", (error) => fail("unhandled_rejection", error));
  const warning = (value: Error) => {
    recordDiagnostic("PROCESS_WARNING", {
      reason: value.name === "MaxListenersExceededWarning" ? "listener_limit"
        : value.name === "DeprecationWarning" ? "deprecated" : "unknown",
    });
  };
  process.on("warning", warning);

  const intervalMs = Math.max(1, options.intervalMs ?? DIAGNOSTICS_CONFIG.heartbeatMs);
  let sampledAt = performance.now();
  const sample = (initial = false) => {
    const now = performance.now();
    const memory = process.memoryUsage();
    recordDiagnostic("RUNTIME_HEARTBEAT", {
      uptimeSec: process.uptime(),
      rssMB: memory.rss / 1_048_576,
      heapUsedMB: memory.heapUsed / 1_048_576,
      lagMs: initial ? 0 : Math.max(0, now - sampledAt - intervalMs),
    });
    sampledAt = now;
  };
  sample(true);
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    process.off("warning", warning);
    // Fatal handlers remain during shutdown so cleanup failures are also logged.
  };
}
