import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const backend = fileURLToPath(new URL("../", import.meta.url));
const event = (code: string, timestamp: string, extra = {}) => JSON.stringify({ code, timestamp, ...extra }) + "\n";

test("the logs command sanitizes archived events and follows file rotation without replaying them", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-bot-log-cli-"));
  const filename = path.join(directory, "events.ndjson");
  await writeFile(filename, event("SERVER_STARTED", "2026-10-15T12:00:00Z", {
    message: "private-token", details: { url: "private-token", reason: "private-token", status: 403 },
  }) + "{partial");
  const child = spawn(process.execPath, ["--import", "tsx", "src/logs.ts", "--follow"], {
    cwd: backend,
    env: { ...process.env, DOTENV_CONFIG_PATH: path.join(directory, "no-env"), DIAGNOSTICS_LOG_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const waitFor = async (text: string) => {
    for (let i = 0; i < 160; i++) {
      if (output.includes(text)) return;
      if (child.exitCode !== null) break;
      await delay(25);
    }
    throw new Error(`Missing ${text}: ${output}`);
  };
  try {
    await waitFor("Suivi du journal actif");
    await rename(filename, `${filename}.1`);
    await writeFile(filename, event("MPV_EXITED", "2026-10-15T12:01:00Z", { details: { exitCode: 7 } }));
    await waitFor("MPV_EXITED");
    assert.equal(output.includes("private-token"), false);
    assert.equal((output.match(/SERVER_STARTED/g) || []).length, 1);
    assert.equal((output.match(/MPV_EXITED/g) || []).length, 1);
    assert.match(output, /"exitCode":7/);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
