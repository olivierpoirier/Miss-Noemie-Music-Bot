import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { STEREO_CHECK_GRAPH } from "../src/stereoCheck.js";

const backend = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../src/stereoCheck.ts", import.meta.url));
const savedFilters = [{ name: "lavfi", enabled: true, params: { graph: "volume=0.8" } }];

async function fixture(t: TestContext, mode: "normal" | "disabled" | "interrupt" | "window-missing" = "normal", matchingRoute = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xmbot-stereo-cli-"));
  const socketPath = path.join(directory, "xmb_mpv_a1.sock");
  const logPath = path.join(directory, "pactl-calls");
  const mutations: unknown[][] = [];
  const sockets = new Set<net.Socket>();
  let child: ReturnType<typeof spawn> | undefined;
  let filters: unknown = structuredClone(savedFilters);
  const window = { ready: false, reads: 0, title: "", cachedTitle: "Music Bot - Audio stereo" };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const command = message.command;
        let data: unknown;
        if (command[0] === "get_property") {
          if (command[1] === "vo-configured") {
            window.reads++;
            window.ready = mode !== "window-missing" && window.reads >= 2;
          }
          const properties: Record<string, unknown> = {
            pid: 12345, "audio-device": "pulse/xmbot_sink", "idle-active": false,
            pause: false, "paused-for-cache": false, af: filters, "vo-configured": window.ready,
          };
          data = properties[command[1]];
        }
        if (command[0] === "set_property") {
          mutations.push(command);
          if (command[1] === "af") filters = command[2];
          if (command[1] === "title") {
            if (window.ready && command[2] !== window.cachedTitle) window.title = command[2];
            window.cachedTitle = command[2];
          }
        }
        socket.write(JSON.stringify({ request_id: message.request_id, error: "success", data }) + "\n");
        if (command[0] === "set_property" && command[1] === "af" && mutations.filter((entry) => entry[1] === "af").length === 1) {
          if (mode === "disabled") socket.write(JSON.stringify({ event: "log-message", prefix: "lavfi", level: "error", text: "Disabling filter lavfi.00 because it has failed." }) + "\n");
          if (mode === "interrupt") child?.kill("SIGINT");
        }
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  fs.writeFileSync(path.join(directory, "pactl"), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, 'called\\n');
const entries = process.argv.at(-1) === 'sinks'
  ? [{ index: 78, name: 'xmbot_sink' }]
  : [{ index: 55, sink: 78, properties: { 'application.process.id': ${JSON.stringify(matchingRoute ? "12345" : "99999")} } }];
fs.writeSync(1, JSON.stringify(entries));
`, { mode: 0o755 });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    mutations, logPath, window,
    run: async (args: string[]) => {
      child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
        cwd: backend,
        env: {
          ...process.env, TMPDIR: directory,
          PATH: directory + path.delimiter + process.env.PATH,
          DOTENV_CONFIG_PATH: path.join(directory, "no-env"),
          LINUX_VIRTUAL_SINK_NAME: "xmbot_sink",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (data) => { output += data; });
      child.stderr?.on("data", (data) => { output += data; });
      const timeout = setTimeout(() => child?.kill("SIGKILL"), 12_000);
      const [code, signal] = await once(child, "close");
      clearTimeout(timeout);
      return { code, signal, output };
    },
  };
}

test("stereo CLI defaults to help without inspecting or changing a player", { skip: process.platform !== "linux" }, async (t) => {
  const f = await fixture(t);
  const result = await f.run([]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Sans option/);
  assert.equal(fs.existsSync(f.logPath), false, "default mode must not invoke pactl");
  assert.deepEqual(f.mutations, []);
});

test("stereo dry run verifies PID and Pulse route without modifying filters or window", { skip: process.platform !== "linux" }, async (t) => {
  const f = await fixture(t);
  const result = await f.run(["--dry-run", "--prepare-stream"]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Cible vérifiée : MPV PID 12345/);
  assert.deepEqual(f.mutations, []);
});

test("stereo CLI refuses a player whose PID is not routed into the bot sink", { skip: process.platform !== "linux" }, async (t) => {
  const f = await fixture(t, "normal", false);
  const result = await f.run(["--play"]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Aucun lecteur actif ne correspond/);
  assert.deepEqual(f.mutations, []);
});

test("stream preparation waits for the window and republishes an unchanged cached title without audio filters", { skip: process.platform !== "linux" }, async (t) => {
  const f = await fixture(t);
  const result = await f.run(["--prepare-stream"]);
  assert.equal(result.code, 0, result.output);
  assert.equal(f.window.reads, 2, "the VO must be ready before setting its title");
  assert.equal(f.window.title, "Music Bot - Audio stereo", "reopened native windows must regain their title");
  assert.deepEqual(f.mutations.map((entry) => entry[1]), ["geometry", "force-window", "title", "title"]);
});

test("stream preparation stops without audio when the window never becomes ready", { skip: process.platform !== "linux" }, async (t) => {
  const f = await fixture(t, "window-missing");
  const result = await f.run(["--prepare-stream", "--play"]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /fenêtre MPV n'est pas prête/);
  assert.deepEqual(f.mutations.map((entry) => entry[1]), ["geometry", "force-window"]);
});

for (const mode of ["disabled", "interrupt"] as const) {
  test(`stereo CLI restores the native filter snapshot after ${mode}`, { skip: process.platform !== "linux" }, async (t) => {
    const f = await fixture(t, mode);
    const result = await f.run(["--play"]);
    assert.equal(result.code, 1, result.output);
    assert.equal(result.signal, null, "SIGINT must allow restoration before exit");
    assert.match(result.output, /Filtres d'origine restaurés/);
    assert.match(result.output, mode === "disabled" ? /désactivé le filtre/ : /Test interrompu/);
    const changes = f.mutations.filter((entry) => entry[1] === "af");
    assert.equal(changes.length, 2);
    assert.deepEqual(changes[1], ["set_property", "af", savedFilters]);
  });
}

const mpv = process.env.MPV_BIN || "mpv";
const hasMpv = spawnSync(mpv, ["--version"], { stdio: "ignore", timeout: 5_000 }).status === 0;

test("real mpv renders four isolated left beeps then four right beeps from both input sample rates", { skip: !hasMpv }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xmbot-stereo-render-"));
  try {
    const filtersPath = path.join(directory, "filters.json");
    fs.writeFileSync(filtersPath, JSON.stringify([{ name: "lavfi", enabled: true, params: { graph: STEREO_CHECK_GRAPH } }]));
    const scriptPath = path.join(directory, "native-filter.lua");
    fs.writeFileSync(scriptPath, `local utils = require 'mp.utils'
local f = assert(io.open(${JSON.stringify(filtersPath)}, 'r'))
local filters = assert(utils.parse_json(f:read('*a')))
f:close()
mp.add_hook('on_preloaded', 50, function() mp.set_property_native('af', filters) end)
`);
    for (const rate of [44_100, 48_000]) {
      const frames = rate * 16;
      const wav = Buffer.alloc(44 + frames * 8);
      wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4);
      wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22);
      wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 8, 28);
      wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34);
      wav.write("data", 36); wav.writeUInt32LE(frames * 8, 40);
      for (let frame = 0; frame < frames; frame++) {
        wav.writeFloatLE(0.1 * Math.sin(2 * Math.PI * 330 * frame / rate), 44 + frame * 8);
        wav.writeFloatLE(0.1 * Math.sin(2 * Math.PI * 660 * frame / rate), 48 + frame * 8);
      }
      const sourcePath = path.join(directory, `source-${rate}.wav`);
      const outputPath = path.join(directory, `output-${rate}.raw`);
      fs.writeFileSync(sourcePath, wav);
      const result = spawnSync(mpv, [
        "--no-config", "--video=no", "--ytdl=no", "--load-scripts=no", `--script=${scriptPath}`,
        "--volume=100", "--audio-format=float", "--audio-channels=stereo", "--audio-samplerate=48000",
        "--audio-stream-silence=no", "--idle=no", "--ao=pcm", "--ao-pcm-waveheader=no",
        `--ao-pcm-file=${outputPath}`, sourcePath,
      ], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.doesNotMatch(result.stderr, /Disabling filter|failed to configure/i);
      const output = fs.readFileSync(outputPath);
      assert.equal(output.length, 16 * 48_000 * 8);
      const rms = (channel: number, start: number, end: number) => {
        let energy = 0;
        const first = Math.round(start * 48_000);
        const last = Math.round(end * 48_000);
        for (let frame = first; frame < last; frame++) energy += output.readFloatLE(frame * 8 + channel * 4) ** 2;
        return Math.sqrt(energy / (last - first));
      };
      for (let second = 0; second < 16; second++) {
        for (const channel of [0, 1]) {
          const expectedBeep = channel === 0 ? second >= 1 && second <= 4 : second >= 9 && second <= 12;
          const level = rms(channel, second + 0.1, second + 0.5);
          if (expectedBeep) assert.ok(level > 0.2 && level < 0.22, `${rate} Hz: missing beep at ${second}s, channel ${channel}`);
          else assert.ok(level < 0.000001, `${rate} Hz: unwanted sound at ${second}s, channel ${channel}`);
          assert.ok(rms(channel, second + 0.8, second + 0.95) < 0.000001, "beeps must be separated by silence");
        }
      }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
