import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const backend = fileURLToPath(new URL("../", import.meta.url));

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

async function startServer(idleShutdownMs = "0", environment: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-bot-server-"));
  // No real audio devices or user credentials are used by these tests.
  await writeFile(path.join(directory, "pactl"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
  await writeFile(path.join(directory, "yt-dlp"), `#!${process.execPath}\nrequire('node:fs').writeSync(1, '2026.03.17\\n');\n`, { mode: 0o755 });
  await writeFile(path.join(directory, "mpv"), `#!${process.execPath}\nrequire('node:fs').writeSync(1, 'mpv 0.37.0\\n');\n`, { mode: 0o755 });
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: backend,
    env: {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      PORT: String(port), IDLE_SHUTDOWN_MS: idleShutdownMs,
      DOTENV_CONFIG_PATH: path.join(directory, "no-env"),
      LINUX_ENABLE_VIRTUAL_SINK: "false",
      SPOTIFY_CLIENT_ID: "", SPOTIFY_CLIENT_SECRET: "", SPOTIFY_REFRESH_TOKEN: "",
      YTDLP_BIN: path.join(directory, "yt-dlp"), MPV_BIN: path.join(directory, "mpv"),
      DIAGNOSTICS_LOG_DIR: path.join(directory, "logs"),
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      const fallback = setTimeout(() => child.kill("SIGKILL"), 4000);
      await exit;
      clearTimeout(fallback);
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return { child, url, stop };
      } catch {}
      await delay(50);
    }
    throw new Error(`Server startup timed out: ${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

async function connect(url: string) {
  const ws = new WebSocket(url.replace("http:", "ws:") + "/socket.io/?EIO=4&transport=websocket");
  const messages: any[][] = [];
  const connected = new Promise<void>((resolve, reject) => {
    ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
    ws.addEventListener("message", ({ data }) => {
      const packet = String(data);
      if (packet.startsWith("0")) ws.send("40");
      else if (packet.startsWith("40")) resolve();
      else if (packet === "2") ws.send("3");
      else if (packet.startsWith("42")) messages.push(JSON.parse(packet.slice(2)));
    });
  });
  await Promise.race([connected, delay(3000).then(() => { throw new Error("Socket handshake timed out"); })]);
  const waitFor = async (event: string, predicate = (_: any) => true) => {
    for (let i = 0; i < 100; i++) {
      const index = messages.findIndex(([name, payload]) => name === event && predicate(payload));
      if (index >= 0) return messages.splice(index, 1)[0][1];
      await delay(10);
    }
    throw new Error(`No ${event} response`);
  };
  return { ws, waitFor, emit: (event: string, payload?: unknown) => ws.send(`42${JSON.stringify([event, payload])}`) };
}

test("invalid socket payloads cannot crash the server; failed adds are acknowledged", { timeout: 15000, skip: process.platform !== "linux" }, async () => {
  const server = await startServer();
  let socket: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    socket = await connect(server.url);
    for (const event of ["command", "reorder_queue", "remove_queue_item", "requeue_history_item"]) {
      socket.emit(event, null);
      await socket.waitFor("toast");
    }
    socket.emit("play", { url: 7, clientRequestId: "bad-add" });
    const result = await socket.waitFor("play_result", (result) => result.clientRequestId === "bad-add");
    assert.equal(result.ok, false);
    socket.emit("command", { cmd: "random_mode", arg: true });
    const state = await socket.waitFor("state", (state) => state.control.randomMode);
    assert.equal(state.control.randomMode, true);
    socket.ws.close();
    await delay(100);
    const health = await (await fetch(`${server.url}/health`)).json();
    assert.equal(health.idleShutdownMs, 0);
    assert.equal(health.activeUsers, 0);
    assert.equal(server.child.exitCode, null);
  } finally {
    socket?.ws.close();
    await server.stop();
  }
});

test("diagnostics expose exact tools and retained failures without exposing credentials", { timeout: 15000, skip: process.platform !== "linux" }, async () => {
  const secret = "do-not-expose-test-credentials";
  const server = await startServer("0", { DIAGNOSTICS_ENABLED: "true", SPOTIFY_CLIENT_SECRET: secret, SPOTIFY_REFRESH_TOKEN: secret });
  let socket: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    socket = await connect(server.url);
    socket.emit("command", null);
    await socket.waitFor("toast");
    const response = await fetch(`${server.url}/diagnostics`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.tools.ytDlp.version, "2026.03.17");
    assert.equal(data.tools.ytDlp.status, "warning");
    assert.ok(path.isAbsolute(data.tools.ytDlp.path));
    assert.equal(data.tools.mpv.version, "0.37.0");
    assert.equal(data.player.engineRunning, false);
    assert.equal(data.audioRouting.ready, false);
    assert.equal(data.logging.enabled, true);
    assert.ok(data.recentEvents.some((event: any) => event.code === "SOCKET_COMMAND_FAILED"));
    assert.equal(JSON.stringify(data).includes(secret), false);
    assert.equal(JSON.stringify(data).includes("clientSecret"), false);
    assert.equal(JSON.stringify(data).includes("refreshToken"), false);
    const cached = await (await fetch(`${server.url}/diagnostics`)).json();
    assert.equal(cached.tools.ytDlp.checkedAt, data.tools.ytDlp.checkedAt);
  } finally {
    socket?.ws.close();
    await server.stop();
  }
});

test("optional idle shutdown is cancelled by reconnect and applies after last disconnect", { timeout: 15000, skip: process.platform !== "linux" }, async () => {
  const server = await startServer("500");
  let socket: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    socket = await connect(server.url);
    socket.ws.close();
    await delay(100);
    socket = await connect(server.url);
    await delay(600);
    assert.equal(server.child.exitCode, null);
    const exit = once(server.child, "exit");
    socket.ws.close();
    const [code] = await exit;
    assert.equal(code, 0);
  } finally {
    socket?.ws.close();
    await server.stop();
  }
});
