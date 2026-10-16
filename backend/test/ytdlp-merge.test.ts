import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { mockYoutubeSearch, type YoutubeFixtureItem } from "./helpers/youtube-fixture.js";
import { YTDLP_CONFIG } from "../src/config.js";

const original = { ...YTDLP_CONFIG };
let searchHandler: (query: string) => YoutubeFixtureItem[] | Promise<YoutubeFixtureItem[]>;
let restoreSearch: () => void;
const originalFetch = globalThis.fetch;
let directory: string;
let logPath: string;
let serial = 0;
const fresh = () => import(new URL(`../src/ytdlp.ts?merge=${++serial}`, import.meta.url).href);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const calls = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];
const result = (id: string, title: string, durationInSec = 180) => ({ url: `https://www.youtube.com/watch?v=${id}`, title, durationInSec });

beforeEach(() => {
  searchHandler = () => { throw new Error("Unexpected offline YouTube search"); };
  restoreSearch = mockYoutubeSearch((query) => searchHandler(query));
  globalThis.fetch = (async () => { throw new Error("Unexpected fetch in offline resolver test"); }) as typeof fetch;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "xmbot-merged-extractor-"));
  logPath = path.join(directory, "calls.jsonl");
  const runner = path.join(directory, "extractor.cjs");
  fs.writeFileSync(runner, `
    const fs = require('node:fs');
    const args = process.argv.slice(3);
    fs.appendFileSync(process.argv[2], JSON.stringify(args) + '\\n');
    const index = fs.readFileSync(process.argv[2], 'utf8').trim().split('\\n').length;
    if (args.at(-1).includes('hang=1')) setInterval(() => {}, 1000);
    else setTimeout(() => fs.writeSync(1, JSON.stringify({url:'https://media.invalid/audio?run='+index, webpage_url:'https://www.youtube.com/watch?v=search00001', acodec:'opus',vcodec:'none'})), 10);
  `);
  Object.assign(YTDLP_CONFIG, { bin: process.execPath, baseArgs: [runner, logPath], hasCookies: false, cookiesPath: null, cookiesFromBrowser: "", youtubePlayerClients: "", processTimeoutMs: 2_000, soundCloudPlaybackTimeoutMs: 400, soundCloudMetadataTimeoutMs: 100 });
});

afterEach(() => {
  Object.assign(YTDLP_CONFIG, original);
  restoreSearch();
  globalThis.fetch = originalFetch;
  fs.rmSync(directory, { recursive: true, force: true });
});

test("YouTube matching compares duration and noisy variants, shares requests and returns independent copies", async () => {
  let searches = 0;
  searchHandler = async () => {
    searches++;
    await delay(10);
    return [result("cover000001", "Artist Song cover", 180), result("official001", "Artist Song official audio", 182), result("live0000001", "Artist Song live", 300)];
  };
  const resolver = await fresh();
  const matches = await Promise.all(Array.from({ length: 6 }, () => resolver.searchYoutubeVideo("Artist Song", { expectedDurationSec: 180, limit: 6 })));
  assert.equal(searches, 1);
  assert.ok(matches.every((match) => match.url.includes("official001")));
  matches[0].title = "mutated";
  assert.equal((await resolver.searchYoutubeVideo("Artist Song", { expectedDurationSec: 180, limit: 6 })).title, "Artist Song official audio");
  assert.equal(searches, 1);
});

test("fresh YouTube matching detaches stale searches and does not let them restore old cached matches", async () => {
  let searches = 0;
  let release: (() => void) | undefined;
  searchHandler = async () => {
    const index = ++searches;
    if (index === 1) await new Promise<void>((resolve) => { release = resolve; });
    return [result(index === 1 ? "stale000001" : "fresh000001", "Artist Song")];
  };
  const resolver = await fresh();
  const stale = resolver.searchYoutubeVideo("Artist Song");
  const current = await resolver.searchYoutubeVideo("Artist Song", { bypassCache: true });
  release!();
  await stale;
  assert.ok(current.url.includes("fresh000001"));
  assert.equal((await resolver.searchYoutubeVideo("Artist Song")).url, current.url);
  assert.equal(searches, 2);
});

test("unresponsive play-dl requests stay bounded across repeated search timeouts", async (t) => {
  const resolver = await fresh();
  let searches = 0;
  searchHandler = () => {
    searches++;
    return new Promise<YoutubeFixtureItem[]>(() => {});
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  for (let index = 0; index < 3; index++) {
    const search = resolver.searchYoutubeVideo(`hung search ${index}`);
    await flush();
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal((await search)?.url, "https://www.youtube.com/watch?v=search00001");
  }
  assert.equal((await resolver.searchYoutubeVideo("fourth search uses killable extractor immediately"))?.url, "https://www.youtube.com/watch?v=search00001");
  assert.equal(searches, 3, "timed-out requests must not release slots while their underlying network work remains stuck");
  assert.equal(calls().length, 4, "every search still falls back to yt-dlp");
});

test("yt-dlp search fallback caches stable video pages instead of expiring signed audio streams", async () => {
  searchHandler = () => { throw new Error("play-dl unavailable"); };
  const resolver = await fresh();
  const result = await resolver.searchYoutubeVideo("Artist Song");
  assert.equal(result?.url, "https://www.youtube.com/watch?v=search00001");
  assert.equal((await resolver.searchYoutubeVideo("Artist Song"))?.url, result?.url);
  assert.equal(calls().length, 1);
});

test("SoundCloud query cleaning uses artist and slug when metadata is missing", async () => {
  const { buildSoundCloudYoutubeQuery } = await fresh();
  assert.equal(buildSoundCloudYoutubeQuery("Stream Song by Artist | Listen online for free on SoundCloud"), "Artist - Song");
  assert.equal(buildSoundCloudYoutubeQuery("SoundCloud", "https://soundcloud.com/my-artist/my-song"), "my artist - my song");
  assert.equal(buildSoundCloudYoutubeQuery(null, "https://soundcloud.com/my-artist/my-song"), "my artist - my song");
});

test("SoundCloud short links use bounded oEmbed metadata without spawning an extractor", async () => {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("on.soundcloud.com")) {
      return { url: "https://soundcloud.com/artist/song", status: 200, ok: true, body: { cancel: async () => {} } } as unknown as Response;
    }
    return new Response(JSON.stringify({ title: "Song by Artist", thumbnail_url: "https://image.invalid/cover" }), { status: 200 });
  }) as typeof fetch;
  const { probeSingle } = await fresh();
  const metadata = await probeSingle("https://on.soundcloud.com/abc");
  assert.equal(metadata.title, "Song by Artist");
  assert.equal(requested.length, 2);
  assert.ok(requested[1].includes("soundcloud.com%2Fartist%2Fsong"));
  assert.equal(calls().length, 0);
});

test("transient SoundCloud short-link failures are not cached as successful redirects", async () => {
  YTDLP_CONFIG.cacheTTL = -1;
  let expansions = 0;
  const oembeds: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (new URL(url).hostname === "on.soundcloud.com") {
      const ok = ++expansions > 1;
      return { url: ok ? "https://soundcloud.com/artist/recovered-song" : url, status: ok ? 200 : 503, ok, body: { cancel: async () => {} } } as unknown as Response;
    }
    oembeds.push(url);
    return new Response(JSON.stringify({ title: "Song by Artist" }), { status: 200 });
  }) as typeof fetch;
  const resolver = await fresh();
  await resolver.probeSingle("https://on.soundcloud.com/transient");
  await resolver.probeSingle("https://on.soundcloud.com/transient");
  assert.equal(expansions, 2);
  assert.ok(oembeds.at(-1)?.includes("soundcloud.com%2Fartist%2Frecovered-song"));
});

test("alternate audio extraction skips the failed strategy and shares simultaneous retries", async () => {
  const { getPlayableSource } = await fresh();
  const url = "https://www.youtube.com/watch?v=abcdefghijk";
  const first = await getPlayableSource(url);
  const results = await Promise.all(Array.from({ length: 4 }, () => getPlayableSource(url, "balanced", { bypassCache: true, skipDebugLabels: [first.debugLabel] })));
  assert.equal(calls().length, 2);
  assert.notEqual(results[0].debugLabel, first.debugLabel);
  assert.ok(results.every((source) => source.url === results[0].url));
  assert.equal((await getPlayableSource(url)).url, results[0].url);
});

test("SoundCloud audio extraction respects its shorter total deadline", async () => {
  const { getPlayableSource } = await fresh();
  const startedAt = Date.now();
  assert.equal(await getPlayableSource("https://soundcloud.com/artist/song?hang=1"), null);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(calls().length, 1);
});
