import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mockYoutubeSearch, type YoutubeFixtureItem } from "./helpers/youtube-fixture.js";
import type { QueueItem } from "../src/types.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("merged provider matching keeps playback recovery and cancellation", { skip: process.platform !== "linux" }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xmb-provider-player-"));
  const logPath = path.join(directory, "calls.jsonl");
  const releasePath = path.join(directory, "release");
  const env = { PATH: process.env.PATH, MPV_BIN: process.env.MPV_BIN,
    YTDLP_BIN: process.env.YTDLP_BIN, LINUX_ENABLE_VIRTUAL_SINK: process.env.LINUX_ENABLE_VIRTUAL_SINK,
    PLAYER_PROVIDER_MATCH_CACHE_PATH: process.env.PLAYER_PROVIDER_MATCH_CACHE_PATH,
    FAKE_PROVIDER_LOG: process.env.FAKE_PROVIDER_LOG, FAKE_PROVIDER_RELEASE: process.env.FAKE_PROVIDER_RELEASE };
  const program = (name: string, body: string) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, "#!/usr/bin/env node\n" + body, { mode: 0o755 });
    return file;
  };
  program("pactl", String.raw`
const args = process.argv.slice(2);
console.log(args[0] === "list" ? "1\t" + (args[2] === "sources" ? "xmbot_sink.monitor" : "xmbot_sink") + "\tfake\tRUNNING" : "fake PulseAudio");
`);
  process.env.MPV_BIN = program("mpv", String.raw`
const fs = require("node:fs");
const net = require("node:net");
const log = (entry) => fs.appendFileSync(process.env.FAKE_PROVIDER_LOG, JSON.stringify(entry) + "\n");
const ipc = process.argv.find((arg) => arg.startsWith("--input-ipc-server=")).split("=")[1];
net.createServer((socket) => {
  let buffer = "";
  const send = (data) => socket.write(JSON.stringify(data) + "\n");
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      const [command, url] = message.command;
      if (command === "loadfile") {
        log({ kind: "load", url });
        send({ event: "start-file" });
        if (url.includes("primary-fails")) send({ event: "end-file", reason: "error", error: "HTTP 403" });
        else {
          send({ event: "file-loaded" });
          send({ event: "property-change", name: "time-pos", data: 0 });
          send({ event: "playback-restart" });
        }
      }
      if (command === "stop") send({ event: "end-file", reason: "stop" });
      send({ request_id: message.request_id, error: "success" });
    }
  });
}).listen(ipc);
`);
  process.env.YTDLP_BIN = program("yt-dlp", String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const url = args.at(-1);
fs.appendFileSync(process.env.FAKE_PROVIDER_LOG, JSON.stringify({ kind: "extract", url, args }) + "\n");
if (url.includes("stale") || url.includes("unplayable") || (url.includes("soundcloud.com") && !url.includes("direct-success"))) process.exit(1);
const finish = () => {
  const format = args[args.indexOf("-f") + 1] || "";
  const primary = url.includes("alternate01") && format.startsWith("bestaudio");
  console.log(JSON.stringify({ url: "https://media.invalid/" + (primary ? "primary-fails" : "success") + ".mp3", ext: "mp3", format_id: format }));
};
if (url.includes("barrier1234")) {
  const timer = setInterval(() => { if (fs.existsSync(process.env.FAKE_PROVIDER_RELEASE)) { clearInterval(timer); finish(); } }, 10);
  setTimeout(() => process.exit(1), 10000).unref();
} else finish();
`);
  process.env.PATH = directory + path.delimiter + process.env.PATH;
  process.env.FAKE_PROVIDER_LOG = logPath;
  process.env.FAKE_PROVIDER_RELEASE = releasePath;
  process.env.PLAYER_PROVIDER_MATCH_CACHE_PATH = path.join(directory, "provider-cache.json");
  process.env.LINUX_ENABLE_VIRTUAL_SINK = "false";
  fs.writeFileSync(logPath, "");

  const config = await import("../src/config.js");
  config.PLAYER_CONFIG.preloadAhead = 0;
  config.YTDLP_CONFIG.hasCookies = false;
  config.YTDLP_CONFIG.cookiesPath = null;
  config.YTDLP_CONFIG.cookiesFromBrowser = "";
  config.YTDLP_CONFIG.youtubePlayerClients = "";
  const originalFetch = globalThis.fetch;
  const searches: string[] = [];
  let searchResult = "https://www.youtube.com/watch?v=freshvideo1";
  let searchBarrier: ((value: YoutubeFixtureItem[]) => void) | null = null;
  let holdSearch = false;
  const restoreSearch = mockYoutubeSearch(async (query: string) => {
    searches.push(query);
    if (holdSearch) return await new Promise<YoutubeFixtureItem[]>((resolve) => { searchBarrier = resolve; });
    return [{ url: searchResult, title: query, durationInSec: 180 }];
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "soundcloud.com", "provider test must never use a real network request");
    assert.equal(url.pathname, "/oembed");
    const source = new URL(url.searchParams.get("url")!);
    return new Response(JSON.stringify({ title: `Artist - ${source.pathname.split("/").at(-1)} by Artist`, thumbnail_url: "https://images.invalid/cover.jpg" }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const player = await import("../src/player.js");
  const shared = await import("../src/types.js");
  const cache = await import("../src/providerCache.js");
  const { queueService, createQueueService } = await import("../src/queue.js");
  let nextId = 0;
  const notify = () => {};
  const track = (url: string, extra: Partial<QueueItem> = {}): QueueItem => ({
    id: String(++nextId), url, title: "Track", thumb: null, status: "queued", createdAt: Date.now(), ...extra,
  });
  const entries = () => fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for fake provider process");
      await delay(10);
    }
  };
  const reset = async () => {
    await player.stopPlayer(notify);
    shared.state.queue = [];
    shared.state.history = [];
    holdSearch = false;
    searchBarrier = null;
    searches.length = 0;
    await delay(30);
    fs.writeFileSync(logPath, "");
    fs.rmSync(releasePath, { force: true });
  };
  t.after(async () => {
    await player.stopPlayer(notify);
    await cache.flushProviderMatchCache();
    restoreSearch();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await t.test("MPV refusal switches extractor strategy within the single bounded retry", async () => {
    await reset();
    const current = track("https://www.youtube.com/watch?v=alternate01");
    shared.state.queue = [current];
    await player.ensurePlayerLoop(notify);
    assert.equal(shared.playing?.item, current);
    const extractions = entries().filter((entry) => entry.kind === "extract");
    const loads = entries().filter((entry) => entry.kind === "load");
    assert.equal(loads.length, 2);
    assert.equal(extractions.length, 2);
    assert.notEqual(extractions[0].args[extractions[0].args.indexOf("-f") + 1],
      extractions[1].args[extractions[1].args.indexOf("-f") + 1]);
    assert.match(loads[1].url, /success/);
    assert.equal(player.getPlayerDiagnostics().retryCount, 1);
  });

  await t.test("an obsolete Spotify match is rematched with duration and retained through history", async () => {
    await reset();
    const originalUrl = "provider:spotify:Artist Track official audio";
    const current = track(originalUrl, { durationSec: 180, group: "spotify-group", addedBy: "Olivier" });
    const cacheKey = "spotify|artist track official audio|180";
    cache.setProviderMatch(cacheKey, { url: "https://www.youtube.com/watch?v=stalevideo1" });
    searchResult = "https://www.youtube.com/watch?v=spotifynew1";
    shared.state.queue = [current];
    await player.ensurePlayerLoop(notify);
    assert.equal(shared.playing?.item, current);
    assert.equal(current.url, searchResult);
    assert.equal(current.sourceUrl, originalUrl);
    assert.equal(searches.length, 1);
    assert.equal(searches[0], "Artist Track official audio");
    assert.equal(cache.getProviderMatch(cacheKey)?.url, searchResult);
    await player.skip(notify);
    assert.equal(shared.state.history[0].sourceUrl, originalUrl);
    const replayed = queueService.requeueHistory(current.id);
    assert.equal(replayed?.sourceUrl, originalUrl);
    assert.equal(replayed?.group, "spotify-group");
    assert.equal(replayed?.addedBy, "Olivier");
  });

  await t.test("SoundCloud direct playback is tried before creating a YouTube fallback", async () => {
    await reset();
    const current = track("https://soundcloud.com/artist/direct-success");
    shared.state.queue = [current];
    await player.ensurePlayerLoop(notify);
    assert.equal(shared.playing?.item, current);
    assert.equal(searches.length, 0);
    assert.equal(entries().filter((entry) => entry.kind === "extract").length, 1);
    assert.equal(current.sourceUrl, undefined);
    assert.equal(current.url, "https://soundcloud.com/artist/direct-success");
  });

  await t.test("a stale SoundCloud match falls back without mutating its URL before extraction succeeds", async () => {
    await reset();
    const originalUrl = "https://soundcloud.com/artist/stale-match";
    const current = track(originalUrl, { group: "soundcloud-group" });
    const cacheKey = `soundcloud-fallback|${originalUrl}`;
    cache.setProviderMatch(cacheKey, { url: "https://www.youtube.com/watch?v=stalevideo2" });
    searchResult = "https://www.youtube.com/watch?v=barrier1234";
    shared.state.queue = [current];
    const task = player.ensurePlayerLoop(notify);
    try {
      await until(() => entries().some((entry) => entry.kind === "extract" && entry.url === searchResult));
      assert.equal(current.url, originalUrl);
      assert.equal(current.sourceUrl, undefined);
      assert.equal(cache.getProviderMatch(cacheKey), null);
    } finally {
      fs.writeFileSync(releasePath, "continue");
    }
    await task;
    assert.equal(shared.playing?.item, current);
    assert.equal(current.url, searchResult);
    assert.equal(current.sourceUrl, originalUrl);
    assert.equal(current.group, "soundcloud-group");
    assert.equal(cache.getProviderMatch(cacheKey)?.url, searchResult);
    const urls = entries().filter((entry) => entry.kind === "extract").map((entry) => entry.url);
    assert.ok(urls.indexOf(originalUrl) > urls.indexOf("https://www.youtube.com/watch?v=stalevideo2"));
    assert.ok(urls.indexOf(searchResult) > urls.indexOf(originalUrl));
  });

  await t.test("an unplayable SoundCloud fallback neither replaces the source nor learns a broken match", async () => {
    await reset();
    const originalUrl = "https://soundcloud.com/artist/no-playable";
    const current = track(originalUrl);
    searchResult = "https://www.youtube.com/watch?v=unplayable1";
    shared.state.queue = [current];
    await player.ensurePlayerLoop(notify);
    assert.equal(current.status, "error");
    assert.equal(current.url, originalUrl);
    assert.equal(current.sourceUrl, undefined);
    assert.equal(cache.getProviderMatch(`soundcloud-fallback|${originalUrl}`), null);
    assert.equal(entries().filter((entry) => entry.kind === "load").length, 0);
  });

  await t.test("skip group cancels delayed provider matching and never revives the old track", async () => {
    await reset();
    const originalUrl = "https://soundcloud.com/artist/cancel-match";
    const current = track(originalUrl, { group: "skip-this-group" });
    const sameGroup = track("https://media.invalid/same-group.mp3", { group: "skip-this-group" });
    const next = track("https://media.invalid/after-cancel.mp3");
    holdSearch = true;
    shared.state.queue = [current, sameGroup, next];
    const task = player.ensurePlayerLoop(notify);
    await until(() => searchBarrier !== null);
    await player.skipGroup(notify);
    await task;
    assert.equal(shared.playing?.item, next);
    assert.equal(sameGroup.status, "done");
    assert.equal(current.status, "done");
    searchBarrier!([{ url: "https://www.youtube.com/watch?v=cancelled01", title: "Delayed result", durationInSec: 180 }]);
    await delay(100);
    assert.equal(shared.playing?.item, next);
    assert.equal(current.url, originalUrl);
    assert.equal(current.sourceUrl, undefined);
    assert.equal(cache.getProviderMatch(`soundcloud-fallback|${originalUrl}`), null);
    assert.deepEqual(entries().filter((entry) => entry.kind === "load").map((entry) => entry.url), [next.url]);
  });

  await t.test("restoring previous playback preserves provider identity and collection metadata", () => {
    const previous = track("https://www.youtube.com/watch?v=history1234", {
      sourceUrl: "https://soundcloud.com/artist/original-track", group: "collection", addedBy: "Olivier", status: "done",
    });
    const current = track("https://media.invalid/current.mp3", { status: "playing" });
    const store = { queue: [current], history: [previous] };
    const service = createQueueService(store, { current: 100 });
    const restored = service.restorePrevious(current);
    assert.equal(restored?.sourceUrl, previous.sourceUrl);
    assert.equal(restored?.url, previous.url);
    assert.equal(restored?.group, previous.group);
    assert.equal(restored?.addedBy, previous.addedBy);
  });
});
