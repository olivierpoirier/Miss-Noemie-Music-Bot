import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDiagnosticStore, diagnosticErrorDetails } from "../src/diagnostics.js";

const options = (directory: string) => ({ enabled: true, directory, maxBytes: 4096, maxFiles: 3, maxEvents: 100 });

test("diagnostics persist across restarts and discard raw credential-bearing data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xmb-diagnostics-"));
  try {
    const store = createDiagnosticStore(options(directory));
    await store.initialize();
    const secret = "secret-cookie-token-signed-url";
    store.record("SPOTIFY_REQUEST_FAILED", {
      ...diagnosticErrorDetails(new Error(`HTTP 403 https://media.invalid/audio?token=${secret}`)),
      reason: secret,
      trackId: secret,
      token: secret,
      status: 403,
    } as any);
    await store.flush();
    const raw = await readFile(path.join(directory, "events.ndjson"), "utf8");
    assert.equal(raw.includes(secret), false);
    assert.equal(raw.includes("media.invalid"), false);
    assert.equal(store.status().available, true);
    const event = store.events()[0];
    assert.equal(event.details?.status, 403);
    event.details!.status = 401;
    assert.equal(store.events()[0].details?.status, 403);
    const restored = createDiagnosticStore(options(directory));
    await restored.initialize();
    assert.equal(restored.events()[0].code, "SPOTIFY_REQUEST_FAILED");
    assert.equal(restored.events()[0].details?.status, 403);
    if (process.platform !== "win32") {
      assert.equal((await stat(path.join(directory, "events.ndjson"))).mode & 0o777, 0o600);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rotated files and memory stay bounded while latest events survive a restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xmb-diagnostic-rotation-"));
  try {
    const config = { ...options(directory), maxBytes: 1024, maxEvents: 9 };
    const store = createDiagnosticStore(config);
    await store.initialize();
    for (let index = 0; index < 40; index++) store.record("PLAYBACK_RETRY", { attempt: index });
    await store.flush();
    const names = await readdir(directory);
    assert.equal(names.length, 3);
    for (const name of names) assert.ok((await stat(path.join(directory, name))).size <= 1024);
    assert.equal(store.events().length, 9);
    const restored = createDiagnosticStore(config);
    await restored.initialize();
    assert.equal(restored.events().length, 9);
    assert.equal(restored.events()[0].details?.attempt, 39);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("malformed persisted lines are ignored and known event messages are reconstructed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xmb-diagnostic-corrupt-"));
  try {
    await writeFile(path.join(directory, "events.ndjson"), [
      "{truncated", JSON.stringify({ timestamp: new Date().toISOString(), code: "UNKNOWN", message: "secret" }),
      JSON.stringify({ timestamp: new Date().toISOString(), code: "SERVER_STARTED", message: "secret", details: { token: "secret" } }),
    ].join("\n"));
    const store = createDiagnosticStore(options(directory));
    await store.initialize();
    assert.equal(store.events().length, 1);
    assert.equal(JSON.stringify(store.events()).includes("secret"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unwritable diagnostics never reject playback and disabled stores write nothing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xmb-diagnostic-failure-"));
  try {
    const file = path.join(directory, "not-a-directory");
    await writeFile(file, "occupied");
    const failed = createDiagnosticStore(options(file));
    await failed.initialize();
    failed.record("SERVER_STARTED");
    await failed.flush();
    assert.equal(failed.status().available, false);
    assert.equal(failed.status().droppedWrites, 1);
    assert.equal(failed.events().length, 1);
    const disabled = createDiagnosticStore({ ...options(path.join(directory, "disabled")), enabled: false });
    await disabled.initialize();
    disabled.record("SERVER_STARTED");
    await disabled.flush();
    assert.equal(disabled.status().enabled, false);
    assert.equal(disabled.events().length, 1);
    assert.deepEqual(await readdir(directory), ["not-a-directory"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the first event written after a truncated final line survives the next restart", async () => {
  for (const tail of ["{truncated", JSON.stringify({ timestamp: new Date().toISOString(), code: "TOOL_CHECK_OK" })]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xmb-diagnostic-tail-"));
    try {
      await writeFile(path.join(directory, "events.ndjson"), tail);
      const store = createDiagnosticStore(options(directory));
      await store.initialize();
      store.record("SERVER_STARTED");
      await store.flush();
      const restored = createDiagnosticStore(options(directory));
      await restored.initialize();
      assert.equal(restored.events()[0].code, "SERVER_STARTED");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("error classification retains useful categories without retaining messages", () => {
  assert.deepEqual(diagnosticErrorDetails({ code: "ECONNRESET", message: "secret" }), { reason: "ECONNRESET" });
  assert.deepEqual(diagnosticErrorDetails(new Error("yt-dlp timeout")), { reason: "timeout" });
  assert.deepEqual(diagnosticErrorDetails({ status: 429, message: "secret" }), { status: 429, reason: "rate_limit" });
});

test("process exit codes remain distinct from HTTP statuses", async () => {
  const store = createDiagnosticStore({ ...options("unused"), enabled: false });
  store.record("MPV_EXITED", { exitCode: 7, status: 7 });
  assert.deepEqual(store.events()[0].details, { exitCode: 7 });
});
