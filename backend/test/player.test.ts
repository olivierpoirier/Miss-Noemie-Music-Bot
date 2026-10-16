import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { QueueItem } from "../src/types.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("player recovers and cancels work using fake media/audio processes", { skip: process.platform !== "linux" }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xmb-player-test-"));
  const logFile = path.join(directory, "commands.jsonl");
  const originalEnv = { PATH: process.env.PATH, MPV_BIN: process.env.MPV_BIN, YTDLP_BIN: process.env.YTDLP_BIN,
    LINUX_ENABLE_VIRTUAL_SINK: process.env.LINUX_ENABLE_VIRTUAL_SINK, FAKE_MPV_LOG: process.env.FAKE_MPV_LOG };
  const writeProgram = (name: string, source: string) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, "#!/usr/bin/env node\n" + source, { mode: 0o755 });
    return file;
  };

  writeProgram("pactl", String.raw`
const args = process.argv.slice(2);
if (args[0] === "list") {
  const name = args[2] === "sources" ? "xmbot_sink.monitor" : "xmbot_sink";
  console.log("1\t" + name + "\tfake\tRUNNING");
} else console.log("fake PulseAudio");
`);
  process.env.MPV_BIN = writeProgram("mpv", String.raw`
const fs = require("node:fs");
const net = require("node:net");
const logFile = process.env.FAKE_MPV_LOG;
const log = (entry) => fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
const ipc = process.argv.find((arg) => arg.startsWith("--input-ipc-server=")).split("=")[1];
log({ event: "spawn" });
const server = net.createServer((socket) => {
  let buffer = "";
  const send = (data) => socket.write(JSON.stringify(data) + "\n");
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      log(message);
      const [command, url] = message.command;
      if (command === "loadfile") {
        send({ event: "start-file" });
        const attempts = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse)
          .filter((entry) => entry.command?.[0] === "loadfile" && entry.command[1] === url).length;
        if (url.includes("crash-once") && attempts === 1) process.exit(7);
        if (url.includes("always-fail") || (url.includes("fail-once") && attempts === 1)) {
          send({ event: "end-file", reason: "error", error: "HTTP 403" });
        } else {
          send({ event: "file-loaded" });
          if (url.includes("stop-once") && attempts === 1) {
            send({ event: "end-file", reason: "stop" });
          } else {
            send({ event: "property-change", name: "time-pos", data: 0 });
            send({ event: "playback-restart" });
            if (url.includes("early-eof")) send({ event: "end-file", reason: "eof" });
          }
        }
      }
      if (command === "stop") send({ event: "end-file", reason: "stop" });
      if (command === "fake-end-error") send({ event: "end-file", reason: "error", error: "HTTP 403" });
      if (command === "set_property" && url === "time-pos") {
        if (message.command[2] === 999) {
          send({ request_id: message.request_id, error: "property unavailable" });
          continue;
        }
        send({ event: "property-change", name: "time-pos", data: message.command[2] });
      }
      send({ request_id: message.request_id, error: "success" });
    }
  });
});
server.listen(ipc);
`);
  process.env.YTDLP_BIN = writeProgram("yt-dlp", String.raw`
const fs = require("node:fs");
const url = process.argv.at(-1);
fs.appendFileSync(process.env.FAKE_MPV_LOG, JSON.stringify({ event: "extract", url }) + "\n");
const finish = () => {
  fs.appendFileSync(process.env.FAKE_MPV_LOG, JSON.stringify({ event: "extracted", url }) + "\n");
  console.log(JSON.stringify({ url: "https://media.invalid/resolved.mp3", ext: "mp3" }));
};
if (url.includes("slow-skip")) {
  const deadline = setTimeout(() => process.exit(1), 10_000);
  const interval = setInterval(() => {
    if (!fs.existsSync(process.env.FAKE_MPV_LOG + ".release")) return;
    clearTimeout(deadline);
    clearInterval(interval);
    finish();
  }, 10);
} else setTimeout(finish, 600);
`);
  process.env.PATH = directory + path.delimiter + process.env.PATH;
  process.env.FAKE_MPV_LOG = logFile;
  process.env.LINUX_ENABLE_VIRTUAL_SINK = "false";
  fs.writeFileSync(logFile, "");

  const player = await import("../src/player.js");
  const shared = await import("../src/types.js");
  const { state } = shared;
  let id = 0;
  const notify = () => {};
  const item = (name: string, direct = true): QueueItem => ({ id: String(++id), url: `https://media.invalid/${name}${direct ? ".mp3" : ""}`,
    title: name, thumb: null, status: "queued", createdAt: Date.now() });
  const entries = () => fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const loads = (url?: string) => entries().filter((entry) => entry.command?.[0] === "loadfile" && (!url || entry.command[1] === url));
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for fake process");
      await delay(10);
    }
  };
  const reset = async () => {
    await player.stopPlayer(notify);
    state.queue = [];
    state.history = [];
    state.control.paused = false;
    state.control.repeat = false;
    state.control.randomMode = false;
    await delay(30);
    fs.writeFileSync(logFile, "");
  };
  t.after(async () => {
    await player.stopPlayer(notify);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await t.test("concurrent engine starts share one process", async () => {
    await reset();
    const handles = await Promise.all([player.ensureMpvRunning(), player.ensureMpvRunning(), player.ensureMpvRunning()]);
    assert.equal(handles[0], handles[1]);
    assert.equal(handles[1], handles[2]);
    assert.equal(entries().filter((entry) => entry.event === "spawn").length, 1);
  });

  await t.test("failed sources retry once and then advance instead of leaving the queue stuck", async () => {
    await reset();
    const failed = item("always-fail");
    const next = item("after-error");
    state.queue = [failed, next];
    await player.ensurePlayerLoop(notify);
    assert.equal(failed.status, "error");
    assert.equal(shared.playing?.item.id, next.id);
    assert.equal(loads(failed.url).length, 2);
  });

  await t.test("a process crash during startup retries with a new engine", async () => {
    await reset();
    const current = item("crash-once");
    state.queue = [current];
    await player.ensurePlayerLoop(notify);
    assert.equal(shared.playing?.item.id, current.id);
    assert.equal(loads(current.url).length, 2);
    assert.equal(entries().filter((entry) => entry.event === "spawn").length, 2);
  });

  await t.test("an immediate MPV stop after file-loaded retries without waiting for the watchdog", async () => {
    await reset();
    const current = item("stop-once");
    state.queue = [current];
    await player.ensurePlayerLoop(notify);
    assert.equal(shared.playing?.item.id, current.id);
    assert.equal(loads(current.url).length, 2);
    assert.equal(state.now?.isBuffering, false);
  });

  await t.test("a process crash after startup resumes the queue without a user command", async () => {
    await reset();
    const current = item("mid-track");
    state.queue = [current];
    await player.ensurePlayerLoop(notify);
    const oldPid = shared.playing!.handle.proc.pid;
    shared.playing!.handle.proc.kill("SIGKILL");
    await until(() => Boolean(shared.playing && shared.playing.handle.proc.pid !== oldPid));
    await until(() => loads(current.url).length === 2);
    await player.ensurePlayerLoop(notify);
    assert.equal(current.status, "playing");
  });

  await t.test("watchdog respects pause and restarts an engine that stops progressing", async (context) => {
    await reset();
    const current = item("stall");
    state.queue = [current];
    context.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    try {
      await player.ensurePlayerLoop(notify);
      const oldPid = shared.playing!.handle.proc.pid;
      state.control.paused = true;
      context.mock.timers.tick(90_000);
      assert.equal(shared.playing!.handle.proc.pid, oldPid);
      assert.equal(loads(current.url).length, 1);
      state.control.paused = false;
      context.mock.timers.tick(65_001);
      await player.ensurePlayerLoop(notify);
      assert.notEqual(shared.playing!.handle.proc.pid, oldPid);
      assert.equal(loads(current.url).length, 2);
    } finally {
      context.mock.timers.reset();
    }
  });

  await t.test("confirmed recovery re-arms long streams while rapid relapses stay bounded", async (context) => {
    await reset();
    const current = item("fail-once-long-stream");
    state.queue = [current];
    context.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    try {
      await player.ensurePlayerLoop(notify);
      assert.equal(loads(current.url).length, 2);
      assert.equal(player.getPlayerDiagnostics().retryCount, 1);
      state.control.paused = true;
      context.mock.timers.tick(90_000);
      assert.equal(player.getPlayerDiagnostics().retryCount, 1, "a pause is not healthy playback");
      state.control.paused = false;
      await player.seekAbsolute(100, notify);
      assert.equal(player.getPlayerDiagnostics().retryCount, 1, "a seek is not healthy playback");
      const handle = shared.playing!.handle;
      for (let second = 1; second <= 29; second++) {
        context.mock.timers.tick(1_000);
        await handle.command("set_property", ["time-pos", 100 + second]);
      }
      assert.equal(player.getPlayerDiagnostics().retryCount, 1);
      context.mock.timers.tick(1_000);
      await handle.command("set_property", ["time-pos", 130]);
      assert.equal(player.getPlayerDiagnostics().retryCount, 0);
      await handle.command("fake-end-error");
      await player.ensurePlayerLoop(notify);
      assert.equal(current.status, "playing");
      assert.equal(loads(current.url).length, 3, "a later isolated failure gets a fresh retry");
      await shared.playing!.handle.command("fake-end-error");
      await player.ensurePlayerLoop(notify);
      assert.equal(current.status, "error", "two consecutive errors still abandon the broken source");
      assert.equal(shared.playing, null);
      assert.equal(loads(current.url).length, 3);
    } finally {
      context.mock.timers.reset();
    }
  });

  await t.test("short MPV loops accumulate real recovery progress across repeat boundaries", async (context) => {
    await reset();
    const current = item("fail-once-short-repeat");
    state.queue = [current];
    state.control.repeat = true;
    context.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    try {
      await player.ensurePlayerLoop(notify);
      assert.equal(player.getPlayerDiagnostics().retryCount, 1);
      const handle = shared.playing!.handle;
      for (let second = 1; second <= 35; second++) {
        context.mock.timers.tick(1_000);
        // loop-file rewinds internally without going through seekAbsolute().
        await handle.command("set_property", ["time-pos", second % 10]);
        if (second === 15) assert.equal(player.getPlayerDiagnostics().retryCount, 1);
      }
      assert.equal(player.getPlayerDiagnostics().retryCount, 0);
      assert.equal(current.status, "playing");
    } finally {
      context.mock.timers.reset();
    }
  });

  await t.test("end-file received during startup still starts the following track", async () => {
    await reset();
    const short = item("early-eof");
    const next = item("after-short");
    state.queue = [short, next];
    await player.ensurePlayerLoop(notify);
    assert.equal(short.status, "done");
    assert.equal(shared.playing?.item.id, next.id);
  });

  await t.test("skip cancels slow extraction without waiting or reviving the skipped track", async () => {
    await reset();
    const slow = item("slow-skip", false);
    const next = item("after-slow");
    state.queue = [slow, next];
    const loop = player.ensurePlayerLoop(notify);
    await until(() => entries().some((entry) => entry.event === "extract"));
    // Hold the extractor behind a barrier. A fixed 600 ms delay made this
    // assertion depend on how quickly another fake mpv could start under load.
    try {
      await player.skip(notify);
      await loop;
      assert.equal(shared.playing?.item.id, next.id);
      assert.equal(entries().some((entry) => entry.event === "extracted"), false);
    } finally {
      fs.writeFileSync(logFile + ".release", "continue");
    }
    await until(() => entries().some((entry) => entry.event === "extracted"));
    await delay(30);
    assert.equal(slow.status, "done");
    assert.equal(shared.playing?.item.id, next.id);
    assert.equal(loads("https://media.invalid/resolved.mp3").length, 0);
  });

  await t.test("stop during extraction does not restart any queued track", async () => {
    await reset();
    const slow = item("slow-stop", false);
    const next = item("must-stay-queued");
    state.queue = [slow, next];
    const loop = player.ensurePlayerLoop(notify);
    await until(() => entries().some((entry) => entry.event === "extract"));
    await player.stopPlayer(notify);
    await loop;
    await delay(700);
    assert.equal(shared.playing, null);
    assert.equal(state.now, null);
    assert.equal(next.status, "queued");
    assert.equal(loads().length, 0);
  });

  await t.test("previous stops the saved current handle before loading the previous track", async () => {
    await reset();
    const previous = item("previous");
    previous.status = "done";
    const current = item("current");
    state.history = [previous];
    state.queue = [current];
    await player.ensurePlayerLoop(notify);
    await player.playPrevious(notify);
    await until(() => shared.playing?.item.url === previous.url);
    const commands = entries().filter((entry) => entry.command).map((entry) => entry.command);
    const previousLoadIndex = commands.findIndex((command) => command[0] === "loadfile" && command[1] === previous.url);
    const stopIndex = commands.findIndex((command) => command[0] === "stop");
    assert.ok(stopIndex >= 0 && stopIndex < previousLoadIndex);
    assert.equal(current.status, "queued");
  });

  await t.test("seeks keep early MPV events, clamp duration, and roll back rejected commands", async () => {
    await reset();
    const current = item("seek");
    state.queue = [current];
    await player.ensurePlayerLoop(notify);
    state.control.paused = true;
    await player.seekAbsolute(40, notify);
    assert.equal(state.now!.positionOffsetSec, 40);
    assert.equal(state.now!.isBuffering, false, "time-pos before acknowledgement must remain authoritative");
    const snapshot = { ...state.now };
    await assert.rejects(player.seekAbsolute(999, notify), /property unavailable/);
    assert.deepEqual(state.now, snapshot);
    state.now!.durationSec = 60;
    await player.seekRelative(100, notify);
    assert.equal(state.now!.positionOffsetSec, 60);
  });
});
