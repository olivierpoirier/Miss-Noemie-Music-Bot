import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type net from "node:net";
import { test } from "node:test";
import { MpvInstance } from "../src/mpv.js";
import { MPV_CONFIG } from "../src/config.js";

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode = null;
  signalCode = null;
  pid = 123;
  kills = 0;
  kill() { this.kills++; return true; }
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  requests: Record<string, unknown>[] = [];
  autoReply = false;
  setEncoding() {}
  write(data: string, callback: (error?: Error) => void) {
    const request = JSON.parse(data);
    this.requests.push(request);
    queueMicrotask(() => {
      callback();
      if (this.autoReply) this.reply({ request_id: request.request_id, error: "success" });
    });
    return true;
  }
  reply(data: unknown) { this.emit("data", JSON.stringify(data) + "\n"); }
  destroy() {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    this.emit("close");
    return this;
  }
}

function engine() {
  const proc = new FakeProcess();
  const socket = new FakeSocket();
  const instance = new MpvInstance(proc as unknown as ChildProcess, "/tmp/not-a-real-mpv.sock");
  instance.sock = socket as unknown as net.Socket;
  // Exercise the actual IPC parser and error handlers without opening a device.
  (instance as unknown as { setupSocketListeners(): void }).setupSocketListeners();
  return { proc, socket, instance };
}

test("MPV commands wait for their matching reply and surface rejected commands", async () => {
  const { instance, socket } = engine();
  let settled = false;
  const command = instance.send({ command: ["set_property", "pause", false] }).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "a successful socket write is not a command acknowledgement");
  const requestId = socket.requests[0].request_id;
  const reply = JSON.stringify({ request_id: requestId, error: "success" }) + "\n";
  socket.emit("data", reply.slice(0, 8));
  socket.emit("data", reply.slice(8));
  await command;
  const rejected = instance.send({ command: ["invalid-command"] });
  socket.reply({ request_id: socket.requests[1].request_id, error: "command not found" });
  await assert.rejects(rejected, /command not found/);
  instance.kill();
});

test("socket errors reject all pending work and terminate the disconnected engine", async () => {
  const { instance, socket, proc } = engine();
  const command = assert.rejects(instance.send({ command: ["loadfile", "example.mp3"] }), /broken pipe/);
  const playback = assert.rejects(instance.waitForPlaybackStart(), /broken pipe/);
  assert.doesNotThrow(() => socket.emit("error", new Error("broken pipe")));
  await Promise.all([command, playback]);
  assert.equal(proc.kills, 1);
  await assert.rejects(instance.send({ command: ["stop"] }), /broken pipe/);
  await assert.rejects(instance.waitForPlaybackStart(), /broken pipe/);
});

test("MPV command timeouts are bounded and invalidate the transport", async () => {
  const { instance, socket } = engine();
  const previous = MPV_CONFIG.ipcConnectTimeoutMs;
  MPV_CONFIG.ipcConnectTimeoutMs = 25;
  try {
    await assert.rejects(instance.send({ command: ["stop"] }), /Timeout commande IPC/);
    assert.equal(socket.destroyed, true);
  } finally {
    MPV_CONFIG.ipcConnectTimeoutMs = previous;
    instance.kill();
  }
});

test("replacement ignores old end-file events and a paused file satisfies every start waiter", async () => {
  const { instance, socket } = engine();
  const events: unknown[] = [];
  instance.on("mpv-event", (event) => events.push(event));
  instance.prepareForPlayback();
  const first = instance.waitForPlaybackStart();
  const second = instance.waitForPlaybackStart();
  socket.reply({ event: "end-file", reason: "stop" });
  socket.reply({ event: "property-change", name: "duration", data: 100 });
  assert.equal(instance.started, false);
  assert.deepEqual(events, []);
  socket.reply({ event: "start-file" });
  socket.reply({ event: "property-change", name: "duration", data: 100 });
  assert.equal(instance.started, false, "metadata alone does not confirm playback");
  socket.reply({ event: "file-loaded" });
  await Promise.all([first, second]);
  assert.equal(instance.started, true);
  instance.kill();
});

test("failed playback rejects promptly, even after file-loaded and before the caller starts waiting", async () => {
  const { instance, socket } = engine();
  instance.prepareForPlayback();
  socket.reply({ event: "start-file" });
  socket.reply({ event: "file-loaded" });
  socket.reply({ event: "end-file", reason: "error", error: "network error" });
  await assert.rejects(instance.waitForPlaybackStart(), /network error/);
  instance.kill();
});
