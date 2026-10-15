import assert from "node:assert/strict";
import test from "node:test";
import { createToolInspector, parseToolVersion } from "../src/toolDiagnostics.js";

test("tool versions identify stale yt-dlp releases, nightly builds and invalid output", () => {
  const at = Date.UTC(2026, 9, 15);
  assert.deepEqual(parseToolVersion("ytDlp", "2026.10.14\n", at), { version: "2026.10.14", ageDays: 1 });
  assert.ok(parseToolVersion("ytDlp", "2026.03.17", at).ageDays! > 90);
  assert.equal(parseToolVersion("ytDlp", "2026.10.15.232339", at).version, "2026.10.15.232339");
  assert.equal(parseToolVersion("ytDlp", "2026.02.30", at).version, null);
  assert.equal(parseToolVersion("ytDlp", "raw secret https://media.invalid", at).version, null);
  assert.deepEqual(parseToolVersion("mpv", "mpv 0.37.0 Copyright", at), { version: "0.37.0", ageDays: null });
});

test("concurrent checks share probes and cache the exact configured executable", async () => {
  let now = Date.UTC(2026, 9, 15), calls = 0;
  const inspector = createToolInspector({ ytDlp: process.execPath, mpv: "missing-mpv-fixture" }, async (bin) => {
    calls++;
    return { ok: true, output: bin === process.execPath ? "2026.03.17" : "mpv 0.37.0" };
  }, () => now);
  const first = inspector.check(), second = inspector.check();
  assert.strictEqual(first, second);
  const tools = await first;
  assert.equal(calls, 2);
  assert.equal(tools.ytDlp.path, process.execPath);
  assert.equal(tools.ytDlp.status, "warning");
  assert.equal(tools.mpv.status, "ok");
  tools.ytDlp.path = "changed";
  assert.equal(inspector.snapshot().ytDlp.path, process.execPath);
  await inspector.check();
  assert.equal(calls, 2);
  now += 600_001;
  await inspector.check();
  assert.equal(calls, 4);
});

test("probe failures are actionable without exposing subprocess output", async () => {
  const inspector = createToolInspector({ ytDlp: "missing-yt-dlp-fixture", mpv: "missing-mpv-fixture" }, async () => {
    throw new Error("https://media.invalid/private?token=secret");
  });
  const tools = await inspector.check();
  assert.equal(tools.ytDlp.status, "error");
  assert.equal(tools.mpv.status, "error");
  assert.equal(JSON.stringify(tools).includes("secret"), false);
  assert.equal(tools.ytDlp.version, null);
});
