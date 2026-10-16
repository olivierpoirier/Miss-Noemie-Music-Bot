import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const backend = fileURLToPath(new URL("../", import.meta.url));
const secret = "private-token-never-persist-this";

async function fixture(code: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-bot-runtime-"));
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    const { installRuntimeDiagnostics } = await import('./src/runtimeDiagnostics.ts');
    const { diagnostics } = await import('./src/diagnostics.ts');
    await diagnostics.initialize();
    ${code}
  `], {
    cwd: backend,
    env: { ...process.env, DOTENV_CONFIG_PATH: path.join(directory, "no-env"), DIAGNOSTICS_ENABLED: "true", DIAGNOSTICS_LOG_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const [exitCode, signal] = await once(child, "exit");
    assert.equal(signal, null, output);
    const raw = await readFile(path.join(directory, "events.ndjson"), "utf8");
    const events = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { exitCode, output, raw, events };
  } finally {
    clearTimeout(deadline);
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [kind, code] of [
  ["PROCESS_UNCAUGHT_EXCEPTION", `setTimeout(() => { throw new Error('HTTP 403 https://private.invalid/?token=${secret}'); }, 10);`],
  ["PROCESS_UNHANDLED_REJECTION", `void Promise.reject(new Error('HTTP 403 https://private.invalid/?token=${secret}'));`],
] as const) {
  test(`fatal ${kind} is retained before exiting with code 1`, { timeout: 8_000 }, async () => {
    const result = await fixture(`
      installRuntimeDiagnostics({ onFatal: async () => { await diagnostics.flush(); } });
      ${code}
    `);
    assert.equal(result.exitCode, 1);
    assert.equal(result.raw.includes(secret), false);
    assert.equal(result.output.includes(secret), false);
    const event = result.events.find((event) => event.code === kind);
    assert.equal(event.details.status, 403);
    assert.equal(event.details.reason, "forbidden");
  });
}

test("runtime reports bounded public memory samples and stops its periodic timer during shutdown", { timeout: 8_000 }, async () => {
  const result = await fixture(`
    const stop = installRuntimeDiagnostics({ onFatal: () => {}, intervalMs: 10 });
    process.emitWarning('${secret}', { type: 'MaxListenersExceededWarning' });
    await new Promise(resolve => setTimeout(resolve, 45));
    stop();
    const count = diagnostics.events().filter(event => event.code === 'RUNTIME_HEARTBEAT').length;
    await new Promise(resolve => setTimeout(resolve, 35));
    if (diagnostics.events().filter(event => event.code === 'RUNTIME_HEARTBEAT').length !== count) process.exitCode = 7;
    await diagnostics.flush();
  `);
  assert.equal(result.exitCode, 0);
  assert.equal(result.raw.includes(secret), false);
  assert.ok(result.events.some((event) => event.code === "PROCESS_WARNING" && event.details.reason === "listener_limit"));
  const samples = result.events.filter((event) => event.code === "RUNTIME_HEARTBEAT");
  assert.ok(samples.length >= 2);
  assert.ok(samples.every((event) => event.details.rssMB > 0 && Number.isFinite(event.details.lagMs)));
  assert.equal(new Set(result.events.map((event) => event.runId)).size, 1);
});

test("a fatal error exits even when application cleanup never resolves", { timeout: 8_000 }, async () => {
  const result = await fixture(`
    installRuntimeDiagnostics({ onFatal: () => new Promise(() => {}) });
    setInterval(() => {}, 1_000);
    setTimeout(() => { throw new Error('${secret}'); }, 10);
  `);
  assert.equal(result.exitCode, 1);
  assert.ok(result.events.some((event) => event.code === "PROCESS_UNCAUGHT_EXCEPTION"));
});
